/**
 * The internal API for the Aatmiq panel inside Aatmiq Code. The IDE server holds a per-person
 * token (AATMIQ_CODE_TOKEN); with it the panel can run Work AI tasks in that person's own Code
 * workspaces, and nothing else.
 *
 *   GET  /api/internal/code/context?folder=     the Code workspace for an open folder, models
 *   GET  /api/internal/code/tasks?codeWorkspaceId=
 *   POST /api/internal/code/tasks               {codeWorkspaceId, prompt, modelId?}
 *   GET  /api/internal/code/tasks/:id           task + timeline
 *   GET  /api/internal/code/tasks/:id/stream    SSE (same as Work AI)
 *   POST /api/internal/code/tasks/:id/messages  {prompt}
 *   POST /api/internal/code/tasks/:id/cancel
 *   POST /api/internal/code/approvals/:id       {decision}
 */
import { and, asc, codeWorkspace, desc, eq, user, workApproval, workEvent, workTask } from "@aatmiq/db";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { resolve } from "node:path";
import { z } from "zod";
import { audit, parse, type AppContext, type SessionUser } from "../context";
import { HttpError, notFound } from "../errors";
import { availableModels, type AvailableModel } from "../services/models";
import { quotaFor } from "../services/quota";
import { titleFrom } from "../services/work";
import { streamTask } from "./work";

const BASE = "/api/internal/code";
const internal = { config: { rateLimit: false } } as const;

export async function codeInternalRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, work } = ctx;

  /** The person whose IDE sent this request. */
  const person = async (req: FastifyRequest): Promise<SessionUser> => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    const userId = token ? ctx.code.fromToken(token) : null;
    if (!userId) throw new HttpError(401, "This IDE session has ended. Reload the window.", "unauthorized");
    const [u] = await db.select({ id: user.id, name: user.name, email: user.email, image: user.image, orgRole: user.orgRole, status: user.status }).from(user).where(eq(user.id, userId));
    if (!u || u.status !== "active") throw new HttpError(401, "Your account isn't active.", "unauthorized");
    if (!(await ctx.license.hasSection("code"))) throw new HttpError(403, "Code isn't included in your organization's license.", "forbidden");
    return { id: u.id, name: u.name, email: u.email, image: u.image, orgRole: u.orgRole };
  };

  const ownWorkspace = async (u: SessionUser, id: string) => {
    const [w] = await db.select().from(codeWorkspace).where(eq(codeWorkspace.id, id));
    if (!w || w.userId !== u.id) throw notFound("Workspace not found");
    return w;
  };
  const ownTask = async (u: SessionUser, id: string) => {
    const [t] = await db.select().from(workTask).where(eq(workTask.id, id));
    if (!t || t.userId !== u.id || !t.codeWorkspaceId) throw notFound("Task not found");
    return t;
  };
  const requireQuota = async (workspaceId: string, userId: string, m: AvailableModel) => {
    const { status: q } = await quotaFor(db, workspaceId, userId, m);
    if (!q.result.allowed)
      throw new HttpError(402, q.scope.kind === "group" ? `You've used your share of the ${q.scope.name} group's tokens for this period.` : "You've used your token allowance for this period.", "quota_exceeded");
  };

  app.get<{ Querystring: { folder?: string } }>(`${BASE}/context`, internal, async (req) => {
    const u = await person(req);
    const folder = resolve(req.query.folder ?? "");
    const rows = await db.select().from(codeWorkspace).where(eq(codeWorkspace.userId, u.id));
    const w = rows.find((r) => ctx.code.workspacePath(u.id, r.slug) === folder);
    if (!w) return { workspace: null, models: [] };
    const models = await availableModels(db, w.workspaceId, "code", u.id);
    return { workspace: { id: w.id, name: w.name }, user: { name: u.name }, models: models.map((m) => ({ id: m.id, name: m.displayName, isDefault: m.isDefault })) };
  });

  app.get<{ Querystring: { codeWorkspaceId?: string } }>(`${BASE}/tasks`, internal, async (req) => {
    const u = await person(req);
    const w = await ownWorkspace(u, req.query.codeWorkspaceId ?? "");
    return db
      .select({ id: workTask.id, title: workTask.title, status: workTask.status, updatedAt: workTask.updatedAt })
      .from(workTask)
      .where(and(eq(workTask.codeWorkspaceId, w.id), eq(workTask.userId, u.id)))
      .orderBy(desc(workTask.updatedAt))
      .limit(30);
  });

  const createSchema = z.object({ codeWorkspaceId: z.string(), prompt: z.string().trim().min(1).max(50_000), modelId: z.string().optional() });
  app.post(`${BASE}/tasks`, internal, async (req) => {
    const u = await person(req);
    const b = parse(createSchema, req.body);
    const w = await ownWorkspace(u, b.codeWorkspaceId);
    const models = await availableModels(db, w.workspaceId, "code", u.id);
    const m = (b.modelId && models.find((x) => x.id === b.modelId)) || models.find((x) => x.isDefault) || models.find((x) => !x.groups.length) || models[0];
    if (!m) throw new HttpError(400, "No model is enabled for Code in this workspace. Ask your admin.", "bad_request");
    await requireQuota(w.workspaceId, u.id, m);
    const [t] = await db
      .insert(workTask)
      .values({ workspaceId: w.workspaceId, userId: u.id, title: titleFrom(b.prompt), modelId: m.id, codeWorkspaceId: w.id })
      .returning();
    await work.submit(t!.id, b.prompt);
    return { id: t!.id, title: t!.title };
  });

  app.get<{ Params: { id: string } }>(`${BASE}/tasks/:id`, internal, async (req) => {
    const u = await person(req);
    const t = await ownTask(u, req.params.id);
    const events = await db
      .select({ seq: workEvent.seq, kind: workEvent.kind, data: workEvent.data })
      .from(workEvent)
      .where(eq(workEvent.taskId, t.id))
      .orderBy(asc(workEvent.seq));
    return { task: { id: t.id, title: t.title, status: t.status, error: t.error }, events };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>(`${BASE}/tasks/:id/stream`, internal, async (req, reply) => {
    const u = await person(req);
    const t = await ownTask(u, req.params.id);
    await streamTask(ctx, t.id, Number(req.query.after ?? 0) || 0, reply);
  });

  app.post<{ Params: { id: string } }>(`${BASE}/tasks/:id/messages`, internal, async (req) => {
    const u = await person(req);
    const t = await ownTask(u, req.params.id);
    const b = parse(z.object({ prompt: z.string().trim().min(1).max(50_000) }), req.body);
    const models = await availableModels(db, t.workspaceId, "code", u.id);
    const m = models.find((x) => x.id === t.modelId) ?? models.find((x) => x.isDefault) ?? models.find((x) => !x.groups.length) ?? models[0];
    if (!m) throw new HttpError(400, "No model is enabled for Code in this workspace. Ask your admin.", "bad_request");
    await requireQuota(t.workspaceId, u.id, m);
    await work.submit(t.id, b.prompt);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(`${BASE}/tasks/:id/cancel`, internal, async (req) => {
    const u = await person(req);
    const t = await ownTask(u, req.params.id);
    await work.cancel(t.id);
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>(`${BASE}/approvals/:id`, internal, async (req) => {
    const u = await person(req);
    const b = parse(z.object({ decision: z.enum(["approve", "reject"]) }), req.body);
    const [a] = await db
      .select({ id: workApproval.id, taskId: workApproval.taskId, toolName: workApproval.toolName, userId: workTask.userId, workspaceId: workTask.workspaceId })
      .from(workApproval)
      .innerJoin(workTask, eq(workTask.id, workApproval.taskId))
      .where(eq(workApproval.id, req.params.id));
    if (!a || a.userId !== u.id) throw notFound("Approval not found");
    const decided = await work.decide(a.id, b.decision === "approve" ? "approved" : "rejected", u.id);
    if (!decided) throw new HttpError(409, "This request was already answered.", "conflict");
    await audit(ctx, { actor: u, action: `work.approval.${decided.status}`, workspaceId: a.workspaceId, targetType: "work_task", targetId: a.taskId, meta: { tool: a.toolName, via: "code" } });
    return { status: decided.status };
  });
}
