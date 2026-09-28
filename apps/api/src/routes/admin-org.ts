import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  invitation,
  isNull,
  session,
  sql,
  user,
  workspace,
  workspaceMember,
  workspaceModel,
  model,
  usageEvent,
  tokenRequest,
} from "@aatmiq/db";
import {
  budgetSchema,
  inviteSchema,
  isOrgAdmin,
  memberSchema,
  ORG_ROLES,
  periodStart,
  SECTIONS,
  userQuotaSchema,
  WORKSPACE_ROLES,
  workspaceModelsSchema,
  workspaceSchema,
  defaultUserQuota,
} from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  audit,
  parse,
  requireOrgCap,
  requireUser,
  requireWorkspaceCap,
  type AppContext,
} from "../context";
import { randomToken, sha256 } from "../crypto";
import { badRequest, conflict, forbidden, notFound } from "../errors";
import { getOrgPeriod } from "../services/quota";

const INVITE_TTL_DAYS = 7;

// Drizzle omits table prefixes in single-table selects, so correlated subqueries must
// reference the outer row explicitly (otherwise "id" binds to the inner table).
const OUTER_USER_ID = sql.raw(`"user"."id"`);
const OUTER_WORKSPACE_ID = sql.raw(`"workspace"."id"`);

export async function adminOrgRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg } = ctx;

  /* ───────────── Users & invitations (org admins only; D18) ───────────── */

  app.get("/api/admin/users", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.manage");
    const start = periodStart(await getOrgPeriod(db));
    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        orgRole: user.orgRole,
        status: user.status,
        jobTitle: user.jobTitle,
        lastActiveAt: user.lastActiveAt,
        createdAt: user.createdAt,
        tokensThisPeriod: sql<number>`coalesce((select sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}) from ${usageEvent} where ${usageEvent.userId} = ${OUTER_USER_ID} and ${usageEvent.createdAt} >= ${start.toISOString()}), 0)::bigint`,
      })
      .from(user)
      .orderBy(asc(user.createdAt));
    const memberships = await db
      .select({ userId: workspaceMember.userId, workspaceId: workspace.id, name: workspace.name, role: workspaceMember.role })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
      .where(isNull(workspace.archivedAt));
    return rows.map((r) => ({
      ...r,
      tokensThisPeriod: Number(r.tokensThisPeriod),
      workspaces: memberships.filter((m) => m.userId === r.id).map(({ userId: _u, ...m }) => m),
    }));
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.manage");
    const body = parse(
      z.object({
        orgRole: z.enum(ORG_ROLES).exclude(["owner"]).optional(),
        status: z.enum(["active", "deactivated"]).optional(),
      }),
      req.body,
    );
    const [target] = await db.select().from(user).where(eq(user.id, req.params.id));
    if (!target) throw notFound("User not found");
    if (target.orgRole === "owner") throw forbidden("The owner's role and status can't be changed here.");
    if (target.id === u.id) throw forbidden("You can't change your own role or status.");
    await db.update(user).set(body).where(eq(user.id, target.id));
    if (body.status === "deactivated") await db.delete(session).where(eq(session.userId, target.id));
    await audit(ctx, {
      actor: u,
      action: body.status === "deactivated" ? "user.deactivated" : body.status === "active" ? "user.reactivated" : "user.role_changed",
      targetType: "user",
      targetId: target.id,
      meta: body,
    });
    return { ok: true };
  });

  app.get("/api/admin/invites", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.invite");
    return db
      .select({
        id: invitation.id,
        email: invitation.email,
        orgRole: invitation.orgRole,
        workspaces: invitation.workspaces,
        expiresAt: invitation.expiresAt,
        createdAt: invitation.createdAt,
      })
      .from(invitation)
      .where(and(isNull(invitation.acceptedAt), isNull(invitation.revokedAt), gte(invitation.expiresAt, new Date())))
      .orderBy(desc(invitation.createdAt));
  });

  /** No SMTP yet: the invite link is returned so the admin can share it (docs/01-foundation.md §3). */
  app.post("/api/admin/invites", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.invite");
    const body = parse(inviteSchema, req.body);
    const email = body.email.toLowerCase();
    const [exists] = await db.select({ id: user.id }).from(user).where(eq(sql`lower(${user.email})`, email));
    if (exists) throw conflict("A user with this email already exists.");
    if (body.workspaces.length) {
      const found = await db
        .select({ id: workspace.id })
        .from(workspace)
        .where(inArray(workspace.id, body.workspaces.map((w) => w.workspaceId)));
      if (found.length !== new Set(body.workspaces.map((w) => w.workspaceId)).size) throw badRequest("Unknown workspace");
    }
    // Re-inviting replaces any open invitation for this email.
    await db
      .update(invitation)
      .set({ revokedAt: new Date() })
      .where(and(eq(invitation.email, email), isNull(invitation.acceptedAt), isNull(invitation.revokedAt)));
    const token = randomToken();
    const [inv] = await db
      .insert(invitation)
      .values({
        email,
        orgRole: body.orgRole,
        workspaces: body.workspaces,
        tokenHash: sha256(token),
        invitedBy: u.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000),
      })
      .returning({ id: invitation.id, expiresAt: invitation.expiresAt });
    await audit(ctx, { actor: u, action: "user.invited", targetType: "invitation", targetId: inv!.id, meta: { email } });
    return { ...inv, email, link: `${cfg.appUrl}/invite/${token}` };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/invites/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.invite");
    await db.update(invitation).set({ revokedAt: new Date() }).where(eq(invitation.id, req.params.id));
    await audit(ctx, { actor: u, action: "user.invite_revoked", targetType: "invitation", targetId: req.params.id });
    return { ok: true };
  });

  /* ───────────── Workspaces ───────────── */

  /** Org admins see all workspaces; workspace admins see the ones they administer. */
  app.get("/api/admin/workspaces", async (req) => {
    const u = await requireUser(ctx, req);
    const start = periodStart(await getOrgPeriod(db));
    let ids: string[] | null = null;
    if (!isOrgAdmin(u.orgRole)) {
      const adminOf = await db
        .select({ id: workspaceMember.workspaceId })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.userId, u.id), eq(workspaceMember.role, "admin")));
      ids = adminOf.map((a) => a.id);
      if (ids.length === 0) throw forbidden();
    }
    const rows = await db
      .select({
        id: workspace.id,
        name: workspace.name,
        icon: workspace.icon,
        description: workspace.description,
        tokenLimit: workspace.tokenLimit,
        defaultModelId: workspace.defaultModelId,
        createdAt: workspace.createdAt,
        memberCount: sql<number>`(select count(*) from ${workspaceMember} where ${workspaceMember.workspaceId} = ${OUTER_WORKSPACE_ID})::int`,
        modelCount: sql<number>`(select count(*) from ${workspaceModel} where ${workspaceModel.workspaceId} = ${OUTER_WORKSPACE_ID})::int`,
        used: sql<number>`coalesce((select sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}) from ${usageEvent} where ${usageEvent.workspaceId} = ${OUTER_WORKSPACE_ID} and ${usageEvent.createdAt} >= ${start.toISOString()}), 0)::bigint`,
        pendingRequests: sql<number>`(select count(*) from ${tokenRequest} where ${tokenRequest.workspaceId} = ${OUTER_WORKSPACE_ID} and ${tokenRequest.status} = 'pending')::int`,
      })
      .from(workspace)
      .where(and(isNull(workspace.archivedAt), ids ? inArray(workspace.id, ids) : undefined))
      .orderBy(asc(workspace.createdAt));
    return rows.map((r) => ({ ...r, used: Number(r.used) }));
  });

  app.post("/api/admin/workspaces", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.workspaces.manage");
    const body = parse(workspaceSchema, req.body);
    const [ws] = await db.insert(workspace).values(body).returning();
    await audit(ctx, { actor: u, action: "workspace.created", workspaceId: ws!.id, targetType: "workspace", targetId: ws!.id, meta: { name: body.name } });
    return ws;
  });

  app.patch<{ Params: { id: string } }>("/api/admin/workspaces/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.workspaces.manage");
    const body = parse(workspaceSchema.partial(), req.body);
    const [ws] = await db.update(workspace).set(body).where(eq(workspace.id, req.params.id)).returning();
    if (!ws) throw notFound("Workspace not found");
    await audit(ctx, { actor: u, action: "workspace.updated", workspaceId: ws.id, targetType: "workspace", targetId: ws.id, meta: body });
    return ws;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/workspaces/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.workspaces.manage");
    const [{ n }] = (await db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspace)
      .where(isNull(workspace.archivedAt))) as [{ n: number }];
    if (n <= 1) throw badRequest("You can't archive the last workspace.");
    await db.update(workspace).set({ archivedAt: new Date() }).where(eq(workspace.id, req.params.id));
    await audit(ctx, { actor: u, action: "workspace.archived", workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id });
    return { ok: true };
  });

  /* ───────────── Members (workspace admins allowed on their own workspace) ───────────── */

  app.get<{ Params: { id: string } }>("/api/admin/workspaces/:id/members", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.members.manage");
    const start = periodStart(await getOrgPeriod(db));
    const [ws] = await db.select({ limit: workspace.tokenLimit }).from(workspace).where(eq(workspace.id, req.params.id));
    const rows = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        status: user.status,
        orgRole: user.orgRole,
        role: workspaceMember.role,
        sections: workspaceMember.sections,
        tokenLimit: workspaceMember.tokenLimit,
        used: sql<number>`coalesce((select sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}) from ${usageEvent} where ${usageEvent.userId} = ${user.id} and ${usageEvent.workspaceId} = ${req.params.id} and ${usageEvent.createdAt} >= ${start.toISOString()}), 0)::bigint`,
      })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .where(eq(workspaceMember.workspaceId, req.params.id))
      .orderBy(asc(user.name));
    const defaultLimit = defaultUserQuota(ws?.limit ?? null, rows.length);
    return rows.map((r) => ({
      ...r,
      used: Number(r.used),
      effectiveLimit: r.tokenLimit ?? defaultLimit,
      isOverride: r.tokenLimit !== null,
    }));
  });

  app.post<{ Params: { id: string } }>("/api/admin/workspaces/:id/members", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.members.manage");
    const body = parse(memberSchema, req.body);
    const [target] = await db.select({ id: user.id }).from(user).where(eq(user.id, body.userId));
    if (!target) throw notFound("User not found");
    await db
      .insert(workspaceMember)
      .values({ workspaceId: req.params.id, userId: body.userId, role: body.role, sections: body.sections })
      .onConflictDoUpdate({
        target: [workspaceMember.workspaceId, workspaceMember.userId],
        set: { role: body.role, sections: body.sections },
      });
    await audit(ctx, { actor: u, action: "workspace.member_added", workspaceId: req.params.id, targetType: "user", targetId: body.userId, meta: { role: body.role } });
    return { ok: true };
  });

  app.patch<{ Params: { id: string; userId: string } }>("/api/admin/workspaces/:id/members/:userId", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.members.manage");
    const body = parse(
      z.object({
        role: z.enum(WORKSPACE_ROLES).optional(),
        sections: z.array(z.enum(SECTIONS)).optional(),
        tokenLimit: userQuotaSchema.shape.tokenLimit.optional(),
      }),
      req.body,
    );
    if (body.tokenLimit !== undefined) await requireWorkspaceCap(ctx, u, req.params.id, "workspace.quotas.manage");
    const [m] = await db
      .update(workspaceMember)
      .set(body)
      .where(and(eq(workspaceMember.workspaceId, req.params.id), eq(workspaceMember.userId, req.params.userId)))
      .returning();
    if (!m) throw notFound("Member not found");
    await audit(ctx, { actor: u, action: body.tokenLimit !== undefined ? "budget.user_quota_changed" : "workspace.member_updated", workspaceId: req.params.id, targetType: "user", targetId: req.params.userId, meta: body });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/admin/workspaces/:id/members/:userId", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.members.manage");
    await db
      .delete(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, req.params.id), eq(workspaceMember.userId, req.params.userId)));
    await audit(ctx, { actor: u, action: "workspace.member_removed", workspaceId: req.params.id, targetType: "user", targetId: req.params.userId });
    return { ok: true };
  });

  /* ───────────── Workspace models & budget ───────────── */

  app.get<{ Params: { id: string } }>("/api/admin/workspaces/:id/models", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.models.grant");
    const rows = await db.select({ modelId: workspaceModel.modelId }).from(workspaceModel).where(eq(workspaceModel.workspaceId, req.params.id));
    const [ws] = await db.select({ d: workspace.defaultModelId }).from(workspace).where(eq(workspace.id, req.params.id));
    return { modelIds: rows.map((r) => r.modelId), defaultModelId: ws?.d ?? null };
  });

  /** Enabling models for a workspace is an org-level decision (docs §4.4). */
  app.put<{ Params: { id: string } }>("/api/admin/workspaces/:id/models", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.models.manage");
    const body = parse(workspaceModelsSchema, req.body);
    const valid = body.modelIds.length
      ? await db.select({ id: model.id }).from(model).where(inArray(model.id, body.modelIds))
      : [];
    const ids = valid.map((v) => v.id);
    await db.transaction(async (tx) => {
      await tx.delete(workspaceModel).where(eq(workspaceModel.workspaceId, req.params.id));
      if (ids.length) await tx.insert(workspaceModel).values(ids.map((modelId) => ({ workspaceId: req.params.id, modelId })));
      const def = body.defaultModelId && ids.includes(body.defaultModelId) ? body.defaultModelId : (ids[0] ?? null);
      await tx.update(workspace).set({ defaultModelId: def }).where(eq(workspace.id, req.params.id));
    });
    await audit(ctx, { actor: u, action: "workspace.models_changed", workspaceId: req.params.id, targetType: "workspace", targetId: req.params.id, meta: { modelIds: ids } });
    return { ok: true };
  });

  app.put<{ Params: { id: string } }>("/api/admin/workspaces/:id/budget", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.budgets.manage");
    const body = parse(budgetSchema.pick({ tokenLimit: true }), req.body);
    const [ws] = await db.update(workspace).set({ tokenLimit: body.tokenLimit }).where(eq(workspace.id, req.params.id)).returning();
    if (!ws) throw notFound("Workspace not found");
    await audit(ctx, { actor: u, action: "budget.changed", workspaceId: ws.id, targetType: "workspace", targetId: ws.id, meta: body });
    return { ok: true };
  });
}
