import { TIERS, FEATURES } from "@aatmiq/license";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, getOrg, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { conflict } from "../errors";

const keySchema = z.object({ key: z.string().trim().min(20).max(10_000) });

export async function licenseRoutes(app: FastifyInstance, ctx: AppContext) {
  const { license, cfg } = ctx;

  async function summary() {
    const info = await license.info();
    const c = info.claims;
    const seats = await license.seatsUsed();
    return {
      required: info.required,
      state: info.status.state,
      canUse: info.status.canUse,
      canAdmin: info.status.canAdmin,
      message: info.status.message,
      daysLeft: info.status.daysLeft,
      license: c && {
        id: c.lid,
        customer: c.customer,
        tier: c.tier,
        tierLabel: TIERS[c.tier]?.label ?? c.tier,
        seats: c.seats,
        sections: c.sections,
        features: c.features.map((f) => ({ id: f, label: FEATURES[f] })),
        workspaceLimit: c.workspaceLimit,
        modelMode: c.modelMode,
        issuedAt: new Date(c.iat * 1000).toISOString(),
        expiresAt: new Date(c.exp * 1000).toISOString(),
        checkInHours: c.checkInHours,
      },
      seatsUsed: seats.active,
      pendingInvites: seats.pending,
      checkIn: info.state && {
        instanceId: info.state.instanceId,
        lastCheckInAt: info.state.lastCheckInAt,
        lastAttemptAt: info.state.lastAttemptAt,
        lastError: info.state.lastError,
        enabled: !!cfg.licenseServerUrl,
      },
      release: info.state?.release ?? null,
      version: cfg.version ?? null,
    };
  }

  app.get("/api/admin/license", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.license.view");
    return summary();
  });

  app.put("/api/admin/license", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.license.manage");
    const { key } = parse(keySchema, req.body);
    const claims = await license.install(key);
    await audit(ctx, { actor: u, action: "license.installed", targetType: "license", targetId: claims.lid, meta: { tier: claims.tier, seats: claims.seats } });
    void license.checkIn().catch(() => {});
    return summary();
  });

  app.post("/api/admin/license/check-in", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.license.view");
    const r = await license.checkIn();
    return { ...(await summary()), result: r };
  });

  /** Setup wizard: show what a key contains before the org exists. */
  app.post("/api/public/license/preview", { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } }, async (req) => {
    if (await getOrg(ctx.db)) throw conflict("Aatmiq is already set up. Enter new keys in Admin → License.");
    const { key } = parse(keySchema, req.body);
    const c = await license.verifyOrThrow(key);
    return { customer: c.customer, tier: TIERS[c.tier]?.label ?? c.tier, seats: c.seats, sections: c.sections, expiresAt: new Date(c.exp * 1000).toISOString(), accent: c.branding?.accent ?? null };
  });
}
