import {
  and,
  asc,
  auditLog,
  desc,
  document,
  eq,
  gte,
  inArray,
  model,
  modelProvider,
  organization,
  sql,
  tokenRequest,
  usageEvent,
  user,
  workspace,
  workspaceMember,
} from "@aatmiq/db";
import { keyStatus, listModels, modelInfo, testProvider } from "@aatmiq/model-gateway";
import {
  BUDGET_PERIODS,
  brandingSchema,
  DEFAULT_ACCENT,
  isOrgAdmin,
  modelSchema,
  modelUpdateSchema,
  orgSettingsSchema,
  PRODUCT_NAME,
  providerSchema,
} from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, getOrg, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { LOGO_TYPES, logoUrl, MAX_LOGO_BYTES, newLogoVersion, sniffLogo, svgProblem } from "../services/branding";

export async function adminSystemRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, cfg } = ctx;

  const providerCfg = (p: typeof modelProvider.$inferSelect) => ({
    id: p.id,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: p.apiKeyEnc ? box.decrypt(p.apiKeyEnc) : null,
  });

  async function loadProvider(id: string) {
    const [p] = await db.select().from(modelProvider).where(eq(modelProvider.id, id));
    if (!p) throw notFound("Provider not found");
    return p;
  }

  /* ───────────── Providers ───────────── */

  app.get("/api/admin/providers", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.providers.manage");
    const rows = await db.select().from(modelProvider).orderBy(asc(modelProvider.createdAt));
    // Keys are never returned; admins see how many there are and which are resting after a limit.
    return rows.map(({ apiKeyEnc, ...p }) => ({ ...p, hasApiKey: !!apiKeyEnc, keys: keyStatus(providerCfg({ ...p, apiKeyEnc })) }));
  });

  app.post("/api/admin/providers", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.providers.manage");
    const body = parse(providerSchema, req.body);
    if (body.type === "mock" && !cfg.allowMockProvider) throw badRequest("The demo provider is disabled on this server.");
    if (body.type !== "mock" && !body.baseUrl) throw badRequest("baseUrl: Base URL is required");
    const [p] = await db
      .insert(modelProvider)
      .values({
        name: body.name,
        type: body.type,
        baseUrl: body.baseUrl ?? null,
        apiKeyEnc: body.apiKey ? box.encrypt(body.apiKey) : null,
      })
      .returning();
    const health = await testProvider(providerCfg(p!));
    await db
      .update(modelProvider)
      .set({ health: { ok: health.ok, latencyMs: health.latencyMs, error: health.error, checkedAt: new Date().toISOString() } })
      .where(eq(modelProvider.id, p!.id));
    await audit(ctx, { actor: u, action: "provider.created", targetType: "provider", targetId: p!.id, meta: { name: body.name, type: body.type } });
    return { id: p!.id, health };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/providers/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.providers.manage");
    await loadProvider(req.params.id);
    const body = parse(providerSchema.partial().omit({ type: true }), req.body);
    await db
      .update(modelProvider)
      .set({
        ...(body.name !== undefined && { name: body.name }),
        ...(body.baseUrl !== undefined && { baseUrl: body.baseUrl }),
        ...(body.apiKey !== undefined && { apiKeyEnc: body.apiKey ? box.encrypt(body.apiKey) : null }),
      })
      .where(eq(modelProvider.id, req.params.id));
    await audit(ctx, { actor: u, action: "provider.updated", targetType: "provider", targetId: req.params.id, meta: { ...body, apiKey: body.apiKey ? "•••" : undefined } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/providers/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.providers.manage");
    await db.delete(modelProvider).where(eq(modelProvider.id, req.params.id));
    await audit(ctx, { actor: u, action: "provider.deleted", targetType: "provider", targetId: req.params.id });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/admin/providers/:id/test", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.providers.manage");
    const p = await loadProvider(req.params.id);
    const health = await testProvider(providerCfg(p));
    await db
      .update(modelProvider)
      .set({ health: { ok: health.ok, latencyMs: health.latencyMs, error: health.error, checkedAt: new Date().toISOString() } })
      .where(eq(modelProvider.id, p.id));
    return health;
  });

  /** Models the provider exposes, marked with whether they're already added. */
  app.get<{ Params: { id: string } }>("/api/admin/providers/:id/discover", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.models.manage");
    const p = await loadProvider(req.params.id);
    const keys = await listModels(providerCfg(p), AbortSignal.timeout(8000)).catch((e: Error) => {
      throw badRequest(`Could not reach provider: ${e.message}`);
    });
    const existing = await db.select({ key: model.modelKey }).from(model).where(eq(model.providerId, p.id));
    const have = new Set(existing.map((e) => e.key));
    return keys.map((key) => ({ modelKey: key, added: have.has(key) }));
  });

  /* ───────────── Models ───────────── */

  app.get("/api/admin/models", async (req) => {
    const u = await requireUser(ctx, req);
    if (!isOrgAdmin(u.orgRole)) {
      // Workspace admins can read the catalog to see what's enabled for their workspace.
      const [m] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.userId, u.id), eq(workspaceMember.role, "admin")));
      if (!m?.n) throw forbidden();
    }
    return db
      .select({
        id: model.id,
        providerId: model.providerId,
        providerName: modelProvider.name,
        providerType: modelProvider.type,
        modelKey: model.modelKey,
        displayName: model.displayName,
        kind: model.kind,
        contextLength: model.contextLength,
        vision: model.vision,
        sections: model.sections,
        enabled: model.enabled,
        costInPerM: model.costInPerM,
        costOutPerM: model.costOutPerM,
      })
      .from(model)
      .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
      .orderBy(asc(model.displayName));
  });

  app.post("/api/admin/models", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.models.manage");
    const body = parse(modelSchema, req.body);
    const p = await loadProvider(body.providerId);
    // Fill in what the provider knows (Ollama reports image support and context length).
    const info = body.vision === undefined || body.contextLength === undefined ? await modelInfo(providerCfg(p), body.modelKey) : {};
    const [m] = await db
      .insert(model)
      .values({ ...body, vision: body.vision ?? info.vision ?? false, contextLength: body.contextLength ?? info.contextLength })
      .onConflictDoNothing()
      .returning();
    if (!m) throw badRequest("This model is already added for that provider.");
    await audit(ctx, { actor: u, action: "model.added", targetType: "model", targetId: m.id, meta: { modelKey: body.modelKey } });
    return m;
  });

  app.patch<{ Params: { id: string } }>("/api/admin/models/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.models.manage");
    const body = parse(modelUpdateSchema, req.body);
    const [m] = await db.update(model).set(body).where(eq(model.id, req.params.id)).returning();
    if (!m) throw notFound("Model not found");
    await audit(ctx, { actor: u, action: body.enabled === false ? "model.disabled" : body.enabled ? "model.enabled" : "model.updated", targetType: "model", targetId: m.id, meta: body });
    return m;
  });

  app.delete<{ Params: { id: string } }>("/api/admin/models/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.models.manage");
    await db.delete(model).where(eq(model.id, req.params.id));
    await audit(ctx, { actor: u, action: "model.deleted", targetType: "model", targetId: req.params.id });
    return { ok: true };
  });

  /* ───────────── Usage analytics (docs §7) ───────────── */

  app.get<{ Querystring: { days?: string; workspaceId?: string } }>("/api/admin/usage", async (req) => {
    const u = await requireUser(ctx, req);
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const since = new Date(Date.now() - days * 86_400_000);

    let wsIds: string[] | null = null;
    if (!isOrgAdmin(u.orgRole)) {
      const adminOf = await db
        .select({ id: workspaceMember.workspaceId })
        .from(workspaceMember)
        .where(and(eq(workspaceMember.userId, u.id), eq(workspaceMember.role, "admin")));
      wsIds = adminOf.map((a) => a.id);
      if (wsIds.length === 0) throw forbidden();
    }
    if (req.query.workspaceId) {
      if (wsIds && !wsIds.includes(req.query.workspaceId)) throw forbidden();
      wsIds = [req.query.workspaceId];
    }
    const where = and(gte(usageEvent.createdAt, since), wsIds ? inArray(usageEvent.workspaceId, wsIds) : undefined);
    const tokens = sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint`;

    const [totals] = await db
      .select({
        input: sql<number>`coalesce(sum(${usageEvent.inputTokens}), 0)::bigint`,
        output: sql<number>`coalesce(sum(${usageEvent.outputTokens}), 0)::bigint`,
        requests: sql<number>`count(*)::int`,
        activeUsers: sql<number>`count(distinct ${usageEvent.userId})::int`,
        avgLatency: sql<number>`coalesce(avg(${usageEvent.latencyMs}), 0)::int`,
        errors: sql<number>`count(*) filter (where ${usageEvent.status} = 'error')::int`,
      })
      .from(usageEvent)
      .where(where);

    const day = sql<string>`to_char(date_trunc('day', ${usageEvent.createdAt} at time zone 'UTC'), 'YYYY-MM-DD')`;
    const daily = await db
      .select({
        date: day,
        input: sql<number>`coalesce(sum(${usageEvent.inputTokens}), 0)::bigint`,
        output: sql<number>`coalesce(sum(${usageEvent.outputTokens}), 0)::bigint`,
      })
      .from(usageEvent)
      .where(where)
      .groupBy(day)
      .orderBy(day);

    const byModel = await db
      .select({ id: model.id, name: sql<string>`coalesce(${model.displayName}, 'Deleted model')`, tokens, requests: sql<number>`count(*)::int` })
      .from(usageEvent)
      .leftJoin(model, eq(model.id, usageEvent.modelId))
      .where(where)
      .groupBy(model.id, model.displayName)
      .orderBy(desc(tokens));

    const byUser = await db
      .select({ id: user.id, name: sql<string>`coalesce(${user.name}, 'Deleted user')`, email: user.email, tokens, requests: sql<number>`count(*)::int` })
      .from(usageEvent)
      .leftJoin(user, eq(user.id, usageEvent.userId))
      .where(where)
      .groupBy(user.id, user.name, user.email)
      .orderBy(desc(tokens))
      .limit(20);

    const bySection = await db
      .select({ section: usageEvent.section, tokens })
      .from(usageEvent)
      .where(where)
      .groupBy(usageEvent.section);

    const byWorkspace = await db
      .select({ id: workspace.id, name: sql<string>`coalesce(${workspace.name}, 'Deleted workspace')`, tokens })
      .from(usageEvent)
      .leftJoin(workspace, eq(workspace.id, usageEvent.workspaceId))
      .where(where)
      .groupBy(workspace.id, workspace.name)
      .orderBy(desc(tokens));

    // Fill empty days so charts have a continuous axis.
    const map = new Map(daily.map((d) => [d.date, d]));
    const series = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      const d = map.get(date);
      series.push({ date, input: Number(d?.input ?? 0), output: Number(d?.output ?? 0) });
    }
    const num = <T extends { tokens: number }>(rows: T[]) => rows.map((r) => ({ ...r, tokens: Number(r.tokens) }));
    return {
      days,
      totals: {
        input: Number(totals?.input ?? 0),
        output: Number(totals?.output ?? 0),
        requests: totals?.requests ?? 0,
        activeUsers: totals?.activeUsers ?? 0,
        avgLatencyMs: totals?.avgLatency ?? 0,
        errors: totals?.errors ?? 0,
      },
      daily: series,
      byModel: num(byModel),
      byUser: num(byUser),
      bySection: num(bySection),
      byWorkspace: num(byWorkspace),
    };
  });

  app.get<{ Querystring: { days?: string; workspaceId?: string } }>("/api/admin/usage/export", async (req, reply) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.usage.view");
    const days = Math.min(365, Math.max(1, Number(req.query.days ?? 30)));
    const rows = await db
      .select({
        time: usageEvent.createdAt,
        user: user.email,
        workspace: workspace.name,
        model: model.displayName,
        section: usageEvent.section,
        input: usageEvent.inputTokens,
        output: usageEvent.outputTokens,
        estimated: usageEvent.estimated,
        latencyMs: usageEvent.latencyMs,
        status: usageEvent.status,
      })
      .from(usageEvent)
      .leftJoin(user, eq(user.id, usageEvent.userId))
      .leftJoin(workspace, eq(workspace.id, usageEvent.workspaceId))
      .leftJoin(model, eq(model.id, usageEvent.modelId))
      .where(
        and(
          gte(usageEvent.createdAt, new Date(Date.now() - days * 86_400_000)),
          req.query.workspaceId ? eq(usageEvent.workspaceId, req.query.workspaceId) : undefined,
        ),
      )
      .orderBy(desc(usageEvent.createdAt))
      .limit(100_000);
    const esc = (v: unknown) => {
      const s = v instanceof Date ? v.toISOString() : String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = "time,user,workspace,model,section,input_tokens,output_tokens,estimated,latency_ms,status";
    const csv = [header, ...rows.map((r) => Object.values(r).map(esc).join(","))].join("\n");
    await audit(ctx, { actor: u, action: "data.usage_exported", meta: { days } });
    reply.header("content-type", "text/csv; charset=utf-8");
    reply.header("content-disposition", `attachment; filename="aatmiq-usage-${days}d.csv"`);
    return csv;
  });

  /* ───────────── Overview ───────────── */

  app.get("/api/admin/overview", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.usage.view");
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [[users], [workspaces], [pending], [tokens30], providers] = await Promise.all([
      db.select({ total: sql<number>`count(*)::int`, active: sql<number>`count(*) filter (where ${user.status} = 'active')::int` }).from(user),
      db.select({ n: sql<number>`count(*)::int` }).from(workspace).where(sql`${workspace.archivedAt} is null`),
      db.select({ n: sql<number>`count(*)::int` }).from(tokenRequest).where(eq(tokenRequest.status, "pending")),
      db
        .select({ n: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint` })
        .from(usageEvent)
        .where(gte(usageEvent.createdAt, since)),
      db.select({ id: modelProvider.id, name: modelProvider.name, type: modelProvider.type, health: modelProvider.health }).from(modelProvider),
    ]);
    const lic = await ctx.license.info();
    return {
      users,
      workspaces: workspaces?.n ?? 0,
      pendingRequests: pending?.n ?? 0,
      tokens30d: Number(tokens30?.n ?? 0),
      providers,
      license: {
        status: lic.status.state,
        tier: lic.claims?.tier ?? null,
        seats: lic.claims?.seats ?? null,
        expiresAt: lic.claims ? new Date(lic.claims.exp * 1000).toISOString() : null,
        message: lic.status.message,
      },
    };
  });

  /* ───────────── Background jobs ───────────── */

  /** Where background jobs run, whether a worker is alive, and what's queued. */
  app.get("/api/admin/jobs", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.audit.view");
    const processing = await db.select({ n: sql<number>`count(*)::int` }).from(document).where(eq(document.status, "processing"));
    return { ...(await ctx.jobs.status()), documentsProcessing: processing[0]?.n ?? 0 };
  });

  /* ───────────── Audit log ───────────── */

  app.get<{ Querystring: { limit?: string; action?: string } }>("/api/admin/audit", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.audit.view");
    return db
      .select()
      .from(auditLog)
      .where(req.query.action ? sql`${auditLog.action} like ${`${req.query.action}%`}` : undefined)
      .orderBy(desc(auditLog.createdAt))
      .limit(Math.min(500, Number(req.query.limit ?? 200)));
  });

  /* ───────────── Settings & branding ───────────── */

  app.get("/api/admin/settings", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.branding.manage");
    const org = await getOrg(db);
    if (!org) throw notFound();
    return {
      name: org.name,
      productName: org.productName ?? PRODUCT_NAME,
      accentColor: org.accentColor ?? DEFAULT_ACCENT,
      loginMessage: org.loginMessage,
      budgetPeriod: org.budgetPeriod,
      promptLogging: org.promptLogging,
      retentionDays: org.retentionDays,
      hasLicense: !!org.licenseKey,
      logoUrl: logoUrl(org.logo),
    };
  });

  /** Upload the organization's logo (one multipart `file`: PNG, JPEG, WebP or SVG, up to 512 KB). */
  app.put("/api/admin/settings/logo", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.branding.manage");
    if (!req.isMultipart()) throw badRequest("Send the logo as multipart/form-data");
    const file = await req.file({ limits: { fileSize: MAX_LOGO_BYTES + 1 } });
    if (!file) throw badRequest("Choose an image file");
    const tooBig = () => badRequest("The logo must be 512 KB or smaller.");
    const data = await file.toBuffer().catch((e: { code?: string }) => {
      throw e.code === "FST_REQ_FILE_TOO_LARGE" ? tooBig() : e;
    });
    if (file.file.truncated || data.length > MAX_LOGO_BYTES) throw tooBig();
    const type = sniffLogo(data);
    if (!type) throw new HttpError(415, "Use a PNG, JPEG, WebP or SVG image.", "unsupported_type");
    if (type === "image/svg+xml") {
      const problem = svgProblem(data);
      if (problem) throw badRequest(`This SVG can't be used because ${problem}. Export it again as a plain SVG or PNG.`);
    }
    const org = await getOrg(db);
    if (!org) throw notFound();
    const version = newLogoVersion();
    const key = `branding/logo-${version}.${LOGO_TYPES[type]}`;
    await ctx.storage.put(key, data);
    await db.update(organization).set({ logo: { key, type, version }, updatedAt: new Date() }).where(eq(organization.id, org.id));
    if (org.logo) await ctx.storage.remove(org.logo.key).catch(() => undefined);
    await audit(ctx, { actor: u, action: "settings.logo_updated", targetType: "organization", targetId: org.id, meta: { type, bytes: data.length } });
    return { logoUrl: logoUrl({ version }) };
  });

  app.delete("/api/admin/settings/logo", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.branding.manage");
    const org = await getOrg(db);
    if (!org) throw notFound();
    if (org.logo) {
      await db.update(organization).set({ logo: null, updatedAt: new Date() }).where(eq(organization.id, org.id));
      await ctx.storage.remove(org.logo.key).catch(() => undefined);
      await audit(ctx, { actor: u, action: "settings.logo_removed", targetType: "organization", targetId: org.id });
    }
    return { logoUrl: null };
  });

  app.put("/api/admin/settings", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.branding.manage");
    const body = parse(
      brandingSchema.extend(orgSettingsSchema.shape).extend({
        name: z.string().trim().min(2).max(80).optional(),
        budgetPeriod: z.enum(BUDGET_PERIODS).optional(),
      }),
      req.body,
    );
    const org = await getOrg(db);
    if (!org) throw notFound();
    await db.update(organization).set(body).where(eq(organization.id, org.id));
    await audit(ctx, {
      actor: u,
      action: body.promptLogging !== undefined && body.promptLogging !== org.promptLogging ? `settings.prompt_logging_${body.promptLogging ? "on" : "off"}` : "settings.changed",
      targetType: "organization",
      targetId: org.id,
      meta: body,
    });
    return { ok: true };
  });
}
