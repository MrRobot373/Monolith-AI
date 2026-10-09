/**
 * Admin → Health: what's working, what isn't and what to do; and whether admins get emailed.
 *
 *   GET  /api/admin/health              a fresh check (asks each model server)
 *   PUT  /api/admin/health/settings     {email}
 *   POST /api/admin/health/test-alert   a test alert to the admin who asks
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { healthSettings, readStatus, runChecks, writeStatus } from "../services/health";

export async function healthRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  app.get("/api/admin/health", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.audit.view");
    const [report, settings, alerts, mailConfigured] = await Promise.all([
      runChecks(ctx),
      healthSettings(db),
      readStatus<Record<string, { since: number; notifiedAt: number }>>(db, "health_alerts"),
      ctx.mail.configured(),
    ]);
    return {
      ...report,
      // When each open problem started, and when admins were last told.
      alerts: alerts?.value ?? {},
      settings: { ...settings, mailConfigured, intervalMinutes: ctx.cfg.healthIntervalMinutes ?? 0 },
    };
  });

  app.put("/api/admin/health/settings", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.audit.view");
    const b = parse(z.object({ email: z.boolean() }), req.body);
    await writeStatus(db, "health_settings", b);
    await audit(ctx, { actor: u, action: "health.settings_changed", meta: b });
    return healthSettings(db);
  });

  app.post("/api/admin/health/test-alert", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.audit.view");
    await ctx.health.tell([{ check: { id: "test", area: "Email", level: "warn", summary: "This is a test alert from Admin → Health.", alert: true }, kind: "problem" }], [u.id]);
    return { ok: true, emailed: (await healthSettings(db)).email && (await ctx.mail.configured()) };
  });
}
