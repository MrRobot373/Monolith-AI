/**
 * Aatmiq Code workspaces: folders of code a person opens in the IDE (empty or cloned from Git).
 * Private to their owner. See docs/07-code.md.
 */
import { and, asc, codeWorkspace, desc, eq, workspaceMember } from "@aatmiq/db";
import { isOrgAdmin } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { parse, requireUser, requireWorkspaceCap, type AppContext, type SessionUser } from "../context";
import { badRequest, forbidden, notFound } from "../errors";
import { fromNodeHeaders } from "better-auth/node";
import { codeSlug } from "../services/code";
import { ideOpenUrl } from "./code-proxy";

/** Code is in the license and enabled for the person in at least one workspace (admins always). */
export async function canUseCode(ctx: AppContext, u: SessionUser): Promise<boolean> {
  if (!(await ctx.license.hasSection("code"))) return false;
  if (isOrgAdmin(u.orgRole)) return true;
  const rows = await ctx.db.select({ sections: workspaceMember.sections }).from(workspaceMember).where(eq(workspaceMember.userId, u.id));
  return rows.some((r) => r.sections.includes("code"));
}

export async function requireCodeSection(ctx: AppContext, u: SessionUser, workspaceId: string) {
  const m = await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
  if (!(await ctx.license.hasSection("code"))) throw forbidden("Code isn't included in your organization's license.");
  if (m && !m.sections.includes("code") && !isOrgAdmin(u.orgRole)) throw forbidden("Code is not enabled for you. Ask your admin.");
}

export async function loadOwnCodeWorkspace(ctx: AppContext, u: SessionUser, id: string) {
  const [w] = await ctx.db.select().from(codeWorkspace).where(eq(codeWorkspace.id, id));
  if (!w || w.userId !== u.id) throw notFound("Workspace not found");
  return w;
}

const createSchema = z.object({
  workspaceId: z.string(),
  name: z.string().trim().min(1).max(80),
  gitUrl: z
    .string()
    .trim()
    .max(500)
    .refine((v) => /^(https?:\/\/|git@|ssh:\/\/)/.test(v), "Use an https://, ssh:// or git@ address")
    .optional()
    .or(z.literal("").transform(() => undefined)),
});

export async function codeRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  const view = (w: typeof codeWorkspace.$inferSelect) => ({ ...w, path: ctx.code.workspacePath(w.userId, w.slug) });

  app.get("/api/code/status", async (req) => {
    const u = await requireUser(ctx, req);
    return { installed: ctx.code.installed, running: ctx.code.running(u.id), allowed: await canUseCode(ctx, u) };
  });

  app.get<{ Querystring: { workspaceId?: string } }>("/api/code/workspaces", async (req) => {
    const u = await requireUser(ctx, req);
    const wsId = req.query.workspaceId ?? "";
    await requireCodeSection(ctx, u, wsId);
    const rows = await db
      .select()
      .from(codeWorkspace)
      .where(and(eq(codeWorkspace.workspaceId, wsId), eq(codeWorkspace.userId, u.id)))
      .orderBy(desc(codeWorkspace.lastOpenedAt), asc(codeWorkspace.name));
    return rows.map(view);
  });

  app.post("/api/code/workspaces", async (req) => {
    const u = await requireUser(ctx, req);
    const b = parse(createSchema, req.body);
    await requireCodeSection(ctx, u, b.workspaceId);
    const base = codeSlug(b.name);
    const taken = new Set((await db.select({ slug: codeWorkspace.slug }).from(codeWorkspace).where(eq(codeWorkspace.userId, u.id))).map((r) => r.slug));
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    const [w] = await db
      .insert(codeWorkspace)
      .values({ workspaceId: b.workspaceId, userId: u.id, name: b.name, slug, gitUrl: b.gitUrl ?? null, status: b.gitUrl ? "cloning" : "ready" })
      .returning();
    const path = ctx.code.workspacePath(u.id, slug);
    if (!b.gitUrl) {
      await ctx.code.prepare(u.id, path);
    } else {
      // Clone as the person, into their home (the folder must not exist yet).
      const uid = await ctx.code.prepare(u.id);
      void clone(b.gitUrl, path, uid).then(
        () => db.update(codeWorkspace).set({ status: "ready", error: null, updatedAt: new Date() }).where(eq(codeWorkspace.id, w!.id)),
        (e: Error) => db.update(codeWorkspace).set({ status: "failed", error: e.message.slice(0, 500), updatedAt: new Date() }).where(eq(codeWorkspace.id, w!.id)),
      );
    }
    return view(w!);
  });

  app.patch<{ Params: { id: string } }>("/api/code/workspaces/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const w = await loadOwnCodeWorkspace(ctx, u, req.params.id);
    const b = parse(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    const [row] = await db.update(codeWorkspace).set({ name: b.name, updatedAt: new Date() }).where(eq(codeWorkspace.id, w.id)).returning();
    return view(row!);
  });

  app.delete<{ Params: { id: string } }>("/api/code/workspaces/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const w = await loadOwnCodeWorkspace(ctx, u, req.params.id);
    await db.delete(codeWorkspace).where(eq(codeWorkspace.id, w.id));
    await rm(ctx.code.workspacePath(u.id, w.slug), { recursive: true, force: true });
    return { ok: true };
  });

  /** Start (or reuse) the person's IDE and return the address that opens this workspace. */
  app.post<{ Params: { id: string } }>("/api/code/workspaces/:id/open", async (req) => {
    const u = await requireUser(ctx, req);
    const w = await loadOwnCodeWorkspace(ctx, u, req.params.id);
    await requireCodeSection(ctx, u, w.workspaceId);
    if (w.status === "cloning") throw badRequest("Still cloning. Try again in a moment.");
    if (w.status === "failed") throw badRequest(w.error ?? "This workspace couldn't be created.");
    const path = ctx.code.workspacePath(u.id, w.slug);
    await ctx.code.prepare(u.id, path);
    await ctx.code.ensure(u.id);
    await db.update(codeWorkspace).set({ lastOpenedAt: new Date() }).where(eq(codeWorkspace.id, w.id));
    const s = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
    // With IDE_URL: a one-time address on the IDE host (each call gives a new one).
    return { url: await ideOpenUrl(ctx, u.id, s!.session.id, path) };
  });

}

/** `git clone` as the given user, without prompts, with a time limit. */
function clone(url: string, dest: string, uid: number | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("git", ["clone", "--", url, dest], {
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: "/nonexistent", GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new" },
      stdio: ["ignore", "ignore", "pipe"],
      ...(uid !== null ? { uid, gid: uid } : {}),
    });
    let err = "";
    p.stderr?.on("data", (b: Buffer) => (err = (err + b.toString()).slice(-1000)));
    const t = setTimeout(() => p.kill("SIGKILL"), 10 * 60_000);
    p.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on("exit", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(err.trim().split("\n").filter(Boolean).slice(-2).join(" ") || `git clone failed (${code})`));
    });
  });
}
