import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  notification,
  sql,
  user,
  workspace,
  workspaceMember,
} from "@aatmiq/db";
import { DEFAULT_ACCENT, isOrgAdmin, PRODUCT_NAME, profileSchema, type Section } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getOrg, parse, requireUser, requireWorkspaceCap, type AppContext } from "../context";
import { forbidden } from "../errors";
import { availableModels } from "../services/models";
import { routingSettings, withAuto } from "../services/router";
import { logoUrl } from "../services/branding";
import { getQuotaStatus, quotaFor } from "../services/quota";

export async function meRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/me", async (req) => {
    const u = await requireUser(ctx, req);
    const org = await getOrg(db);
    const [profile] = await db
      .select({ jobTitle: user.jobTitle, customInstructions: user.customInstructions, createdAt: user.createdAt, emailVerified: user.emailVerified })
      .from(user)
      .where(eq(user.id, u.id));
    const workspaces = await db
      .select({
        id: workspace.id,
        name: workspace.name,
        icon: workspace.icon,
        role: workspaceMember.role,
        sections: workspaceMember.sections,
      })
      .from(workspaceMember)
      .innerJoin(workspace, eq(workspace.id, workspaceMember.workspaceId))
      .where(and(eq(workspaceMember.userId, u.id), isNull(workspace.archivedAt)))
      .orderBy(asc(workspace.createdAt));
    const [unread] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(notification)
      .where(and(eq(notification.userId, u.id), isNull(notification.readAt)));

    void db.update(user).set({ lastActiveAt: new Date() }).where(eq(user.id, u.id)).catch(() => {});
    const lic = await ctx.license.info();
    const admin = isOrgAdmin(u.orgRole);
    return {
      user: { ...u, ...profile, twoFactorSetupRequired: u.twoFactorSetupRequired ?? false, twoFactorDue: u.twoFactorDue ?? null },
      emailEnabled: await ctx.mail.configured(),
      isAdmin: isOrgAdmin(u.orgRole),
      isWorkspaceAdmin: workspaces.some((w) => w.role === "admin"),
      org: {
        name: org?.name ?? "",
        productName: org?.productName ?? PRODUCT_NAME,
        accentColor: org?.accentColor ?? DEFAULT_ACCENT,
        promptLogging: org?.promptLogging ?? false,
        logoUrl: logoUrl(org?.logo),
      },
      workspaces,
      unreadNotifications: unread?.n ?? 0,
      license: {
        state: lic.status.state,
        canUse: lic.status.canUse,
        tier: lic.claims?.tier ?? null,
        sections: lic.status.state === "development" ? ["chat", "work", "code"] : (lic.claims?.sections ?? []),
        features: lic.status.state === "development" ? null : (lic.claims?.features ?? []),
        // Admins see every notice; others only when they can't use the product.
        message: admin || !lic.status.canUse ? lic.status.message : null,
      },
    };
  });

  app.patch("/api/me", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(profileSchema, req.body);
    await db.update(user).set(body).where(eq(user.id, u.id));
    return { ok: true };
  });

  /** Your budget in a workspace; with ?modelId=, the budget that pays for that model (a group's for a group-only model). */
  app.get<{ Params: { id: string }; Querystring: { modelId?: string } }>("/api/workspaces/:id/quota", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.use");
    if (!req.query.modelId) return getQuotaStatus(db, req.params.id, u.id);
    const models = await availableModels(db, req.params.id, "chat", u.id).then(async (c) => [...c, ...(await availableModels(db, req.params.id, "work", u.id))]);
    return (await quotaFor(db, req.params.id, u.id, models.find((m) => m.id === req.query.modelId) ?? null)).status;
  });

  app.get<{ Params: { id: string }; Querystring: { section?: Section } }>("/api/workspaces/:id/models", async (req) => {
    const u = await requireUser(ctx, req);
    const m = await requireWorkspaceCap(ctx, u, req.params.id, "workspace.use");
    const section = req.query.section ?? "chat";
    if (m && !m.sections.includes(section) && !isOrgAdmin(u.orgRole)) throw forbidden("This section is not enabled for you.");
    // Auto first, when the person's models cover two tiers or more.
    return withAuto(await availableModels(db, req.params.id, section, u.id), await routingSettings(db));
  });

  app.get("/api/notifications", async (req) => {
    const u = await requireUser(ctx, req);
    return db
      .select()
      .from(notification)
      .where(eq(notification.userId, u.id))
      .orderBy(desc(notification.createdAt))
      .limit(50);
  });

  app.post("/api/notifications/read", async (req) => {
    const u = await requireUser(ctx, req);
    const { ids } = parse(z.object({ ids: z.array(z.string()).optional() }), req.body);
    const where = ids?.length
      ? and(eq(notification.userId, u.id), inArray(notification.id, ids))
      : eq(notification.userId, u.id);
    await db.update(notification).set({ readAt: new Date() }).where(and(where, isNull(notification.readAt)));
    return { ok: true };
  });
}
