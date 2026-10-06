/**
 * Work AI for people: tasks, their live timeline, approvals and the files the agent works on.
 * Tasks are private to the person who started them.
 */
import { and, asc, desc, eq, ilike, workApproval, workEvent, workTask } from "@aatmiq/db";
import { isOrgAdmin, workMessageSchema, workTaskCreateSchema } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, sep } from "node:path";
import { z } from "zod";
import { audit, parse, requireUser, requireWorkspaceCap, type AppContext, type SessionUser } from "../context";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { resolveModel } from "../services/models";
import { getProjectAccess } from "../services/projects";
import { getQuotaStatus } from "../services/quota";
import { getWorkSettings, titleFrom, type WorkStreamEvent } from "../services/work";

const MAX_FILES = 1000;
const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", ".cache"]);
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/** Content types shown inline; anything else downloads. HTML/SVG are never rendered (served as text). */
const INLINE: Record<string, string> = {
  ".txt": "text/plain", ".md": "text/plain", ".csv": "text/plain", ".json": "text/plain", ".log": "text/plain",
  ".py": "text/plain", ".js": "text/plain", ".ts": "text/plain", ".html": "text/plain", ".svg": "text/plain",
  ".yml": "text/plain", ".yaml": "text/plain", ".sh": "text/plain", ".sql": "text/plain", ".xml": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf",
};

export async function requireWorkSection(ctx: AppContext, u: SessionUser, workspaceId: string) {
  const m = await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
  if (!(await ctx.license.hasSection("work"))) throw forbidden("Work AI isn't included in your organization's license.");
  if (m && !m.sections.includes("work") && !isOrgAdmin(u.orgRole)) throw forbidden("Work AI is not enabled for you. Ask your admin.");
}

async function loadOwnTask(ctx: AppContext, u: SessionUser, id: string) {
  const [t] = await ctx.db.select().from(workTask).where(eq(workTask.id, id));
  if (!t || t.userId !== u.id) throw notFound("Task not found");
  return t;
}

async function requireQuota(ctx: AppContext, workspaceId: string, userId: string) {
  const quota = await getQuotaStatus(ctx.db, workspaceId, userId);
  if (!quota.result.allowed) throw new HttpError(402, "You've used your token allowance for this period.", "quota_exceeded", quota);
}

/** Resolve a path inside the task folder; refuses anything that escapes it (.., symlinks). */
async function safePath(root: string, rel: string) {
  if (!rel || rel.includes("\0")) throw badRequest("Pick a file");
  const full = join(root, rel);
  if (relative(root, full).startsWith("..")) throw notFound("File not found");
  const real = await realpath(full).catch(() => null);
  const realRoot = await realpath(root).catch(() => root);
  if (!real || (real !== realRoot && !real.startsWith(realRoot + sep))) throw notFound("File not found");
  return real;
}

async function listFiles(root: string) {
  const out: { path: string; size: number; modifiedAt: string }[] = [];
  let truncated = false;
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_FILES) {
        truncated = true;
        return;
      }
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await walk(full);
      } else if (e.isFile()) {
        const s = await lstat(full).catch(() => null);
        if (s) out.push({ path: relative(root, full).split(sep).join("/"), size: s.size, modifiedAt: s.mtime.toISOString() });
      }
    }
  };
  await walk(root);
  return { files: out, truncated };
}

export async function workRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, work } = ctx;

  /** What Work AI can do here (for the UI). */
  app.get<{ Querystring: { workspaceId?: string } }>("/api/work/info", async (req) => {
    const u = await requireUser(ctx, req);
    if (req.query.workspaceId) await requireWorkSection(ctx, u, req.query.workspaceId);
    const s = await getWorkSettings(db);
    return { webSearch: !!s.searxngUrl, approvals: s.approvals, allowNetwork: s.allowNetwork, maxConcurrentPerUser: s.maxConcurrentPerUser };
  });

  app.get<{ Querystring: { workspaceId?: string; q?: string } }>("/api/work/tasks", async (req) => {
    const u = await requireUser(ctx, req);
    const wsId = req.query.workspaceId ?? "";
    await requireWorkSection(ctx, u, wsId);
    const q = req.query.q?.trim();
    return db
      .select({
        id: workTask.id,
        title: workTask.title,
        status: workTask.status,
        result: workTask.result,
        error: workTask.error,
        pinned: workTask.pinned,
        modelId: workTask.modelId,
        scheduleId: workTask.scheduleId,
        inputTokens: workTask.inputTokens,
        outputTokens: workTask.outputTokens,
        createdAt: workTask.createdAt,
        updatedAt: workTask.updatedAt,
        finishedAt: workTask.finishedAt,
      })
      .from(workTask)
      .where(and(eq(workTask.workspaceId, wsId), eq(workTask.userId, u.id), q ? ilike(workTask.title, `%${q.replace(/[%_\\]/g, "\\$&")}%`) : undefined))
      .orderBy(desc(workTask.pinned), desc(workTask.updatedAt))
      .limit(200);
  });

  app.post("/api/work/tasks", async (req) => {
    const u = await requireUser(ctx, req);
    const b = parse(workTaskCreateSchema, req.body);
    await requireWorkSection(ctx, u, b.workspaceId);
    await requireQuota(ctx, b.workspaceId, u.id);
    const { model: m } = await resolveModel(db, box, b.workspaceId, "work", b.modelId);
    if (b.projectId) {
      const p = await getProjectAccess(ctx, u, b.projectId);
      if (p.project.workspaceId !== b.workspaceId) throw badRequest("That project is in another workspace.");
    }
    const [t] = await db
      .insert(workTask)
      .values({ workspaceId: b.workspaceId, userId: u.id, title: titleFrom(b.prompt), modelId: m.id, projectId: b.projectId ?? null })
      .returning();
    if (b.start) await work.submit(t!.id, b.prompt);
    const [fresh] = await db.select().from(workTask).where(eq(workTask.id, t!.id));
    return fresh;
  });

  app.get<{ Params: { id: string } }>("/api/work/tasks/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    const events = await db
      .select({ seq: workEvent.seq, kind: workEvent.kind, data: workEvent.data, at: workEvent.createdAt })
      .from(workEvent)
      .where(eq(workEvent.taskId, t.id))
      .orderBy(asc(workEvent.seq))
      .limit(10_000);
    return { task: t, events, live: work.isLive(t.id) };
  });

  /**
   * Live timeline (Server-Sent Events). Replays stored events after `after`, then streams:
   *   event: event  {seq, kind, data, at}   a stored timeline event
   *   event: delta  {text}                  text the model is writing right now
   *   event: files  {}                      the folder may have changed
   */
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>("/api/work/tasks/:id/stream", async (req, reply) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    const after = Number(req.query.after ?? 0) || 0;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let last = after;
    const buffered: WorkStreamEvent[] = [];
    let replaying = true;
    const emit = (e: WorkStreamEvent) => {
      if (e.seq === undefined) return send(e.kind, e.data);
      if (e.seq <= last) return;
      last = e.seq;
      send("event", e);
    };
    const unsubscribe = work.subscribe(t.id, (e) => (replaying ? buffered.push(e) : emit(e)));
    const ping = setInterval(() => res.write(": ping\n\n"), 20_000);
    res.on("close", () => {
      clearInterval(ping);
      unsubscribe();
    });

    const stored = await db
      .select({ seq: workEvent.seq, kind: workEvent.kind, data: workEvent.data, at: workEvent.createdAt })
      .from(workEvent)
      .where(eq(workEvent.taskId, t.id))
      .orderBy(asc(workEvent.seq));
    for (const e of stored) if (e.seq > after) emit({ ...e, at: e.at.toISOString() });
    replaying = false;
    for (const e of buffered.splice(0)) emit(e);
    send("ready", { after: last });
  });

  app.post<{ Params: { id: string } }>("/api/work/tasks/:id/messages", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    await requireWorkSection(ctx, u, t.workspaceId);
    const b = parse(workMessageSchema, req.body);
    await requireQuota(ctx, t.workspaceId, u.id);
    await work.submit(t.id, b.prompt);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/work/tasks/:id/cancel", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    await work.cancel(t.id);
    return { ok: true };
  });

  const taskUpdateSchema = z.object({ title: z.string().trim().min(1).max(200).optional(), pinned: z.boolean().optional() });
  app.patch<{ Params: { id: string } }>("/api/work/tasks/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    const b = parse(taskUpdateSchema, req.body);
    const [row] = await db.update(workTask).set(b).where(eq(workTask.id, t.id)).returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/work/tasks/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    await work.remove(t.id);
    await db.delete(workTask).where(eq(workTask.id, t.id));
    return { ok: true };
  });

  /* ───────────── Approvals ───────────── */

  app.get<{ Querystring: { workspaceId?: string } }>("/api/work/approvals", async (req) => {
    const u = await requireUser(ctx, req);
    return db
      .select({
        id: workApproval.id,
        taskId: workApproval.taskId,
        taskTitle: workTask.title,
        toolName: workApproval.toolName,
        reason: workApproval.reason,
        detail: workApproval.detail,
        createdAt: workApproval.createdAt,
      })
      .from(workApproval)
      .innerJoin(workTask, eq(workTask.id, workApproval.taskId))
      .where(
        and(
          eq(workTask.userId, u.id),
          eq(workApproval.status, "pending"),
          req.query.workspaceId ? eq(workTask.workspaceId, req.query.workspaceId) : undefined,
        ),
      )
      .orderBy(asc(workApproval.createdAt));
  });

  const decideSchema = z.object({ decision: z.enum(["approve", "reject"]) });
  app.post<{ Params: { id: string } }>("/api/work/approvals/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const b = parse(decideSchema, req.body);
    const [a] = await db
      .select({ id: workApproval.id, status: workApproval.status, taskId: workApproval.taskId, toolName: workApproval.toolName, userId: workTask.userId, workspaceId: workTask.workspaceId })
      .from(workApproval)
      .innerJoin(workTask, eq(workTask.id, workApproval.taskId))
      .where(eq(workApproval.id, req.params.id));
    if (!a || a.userId !== u.id) throw notFound("Approval not found");
    if (a.status !== "pending") throw new HttpError(409, `This request was already ${a.status}.`, "conflict");
    const decided = await work.decide(a.id, b.decision === "approve" ? "approved" : "rejected", u.id);
    if (!decided) throw new HttpError(409, "This request was already answered.", "conflict");
    await audit(ctx, {
      actor: u,
      action: `work.approval.${decided.status}`,
      workspaceId: a.workspaceId,
      targetType: "work_task",
      targetId: a.taskId,
      meta: { tool: a.toolName },
      ip: req.ip,
    });
    return { status: decided.status };
  });

  /* ───────────── Files ───────────── */

  app.get<{ Params: { id: string } }>("/api/work/tasks/:id/files", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    return listFiles(work.filesDir(t.id));
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string; download?: string } }>("/api/work/tasks/:id/files/content", async (req, reply) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    const full = await safePath(work.filesDir(t.id), req.query.path ?? "");
    const s = await stat(full).catch(() => null);
    if (!s?.isFile()) throw notFound("File not found");
    const name = basename(full);
    const inline = req.query.download !== "1" ? INLINE[extname(name).toLowerCase()] : undefined;
    reply.header("content-type", inline ? (inline === "text/plain" ? "text/plain; charset=utf-8" : inline) : "application/octet-stream");
    reply.header("content-disposition", `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(name)}`);
    reply.header("content-length", String(s.size));
    reply.header("x-content-type-options", "nosniff");
    reply.header("content-security-policy", "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    return reply.send(createReadStream(full));
  });

  /** Add a file to the task folder (multipart, one `file`; optional `dir`). */
  app.post<{ Params: { id: string } }>("/api/work/tasks/:id/files", async (req) => {
    const u = await requireUser(ctx, req);
    const t = await loadOwnTask(ctx, u, req.params.id);
    await requireWorkSection(ctx, u, t.workspaceId);
    if (!req.isMultipart()) throw badRequest("Send the file as multipart/form-data");
    let saved: string | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })) {
      if (part.type !== "file") continue;
      const data = await part.toBuffer();
      if (part.file.truncated) throw new HttpError(413, "Files can be up to 25 MB.", "too_large");
      const name = basename(part.filename || "upload").replace(/[\\/\0]/g, "_").slice(0, 200) || "upload";
      const root = work.filesDir(t.id);
      await mkdir(root, { recursive: true });
      await writeFile(join(root, name), data);
      saved = name;
    }
    if (!saved) throw badRequest("No file was uploaded");
    work.pulse(t.id, "files", {});
    return { path: saved };
  });
}
