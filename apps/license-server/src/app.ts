import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import {
  FEATURES,
  LicenseError,
  publicKeyOneLine,
  SECTIONS,
  signLicense,
  TIERS,
  verifyLicense,
  type Feature,
  type LicensedSection,
  type LicenseTerms,
  type Tier,
} from "@aatmiq/license";
import { and, desc, eq, lt, sql } from "drizzle-orm";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { decodeProtectedHeader } from "jose";
import { z } from "zod";
import type { Config } from "./config";
import { hashPassword, randomToken, sha256, verifyPassword } from "./crypto";
import { adminAudit, adminSession, adminUser, checkIn, customer, license, setting, type LDB } from "./db";
import type { SigningKeys } from "./keys";

const COOKIE = "aatmiq_sa";
const SESSION_DAYS = 7;

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly code = "error",
  ) {
    super(message);
  }
}

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, i ? `${i.path.join(".") || "input"}: ${i.message}` : "Invalid input", "invalid");
  }
  return r.data;
}

const tierSchema = z.enum(Object.keys(TIERS) as [Tier, ...Tier[]]);
const licenseInput = z.object({
  tier: tierSchema,
  seats: z.number().int().min(1).max(100_000),
  expiresAt: z.coerce.date(),
  sections: z.array(z.enum(SECTIONS)).min(1).optional(),
  features: z.array(z.enum(Object.keys(FEATURES) as [Feature, ...Feature[]])).optional(),
  modelMode: z.enum(["self", "managed"]).default("self"),
  workspaceLimit: z.number().int().min(1).nullable().optional(),
  accent: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  checkInHours: z.number().int().min(1).max(24 * 7).default(24),
});

const checkInSchema = z.object({
  token: z.string().min(20).max(10_000),
  instanceId: z.string().min(8).max(100),
  version: z.string().max(40).optional(),
  activeSeats: z.number().int().min(0),
  usage: z
    .array(z.object({ section: z.string().max(20), inputTokens: z.number().int().min(0), outputTokens: z.number().int().min(0), requests: z.number().int().min(0) }))
    .max(20)
    .default([]),
  health: z.record(z.string(), z.unknown()).optional(),
});

const releaseSchema = z.object({
  version: z.string().trim().min(1).max(40),
  notes: z.string().max(2000).optional(),
  url: z.url().optional().or(z.literal("")),
});

type LicenseRow = typeof license.$inferSelect;

export async function buildApp(db: LDB, cfg: Config, keys: SigningKeys, opts: { logger?: boolean } = {}) {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: true, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: "1 minute" });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: err.message, code: err.code });
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.status(status).send({ error: (err as Error).message, code: "request_error" });
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the license server.", code: "internal" });
  });

  /* ───────────── Helpers ───────────── */

  async function sign(row: LicenseRow, customerName: string) {
    const terms: LicenseTerms = {
      lid: row.id,
      cid: row.customerId,
      customer: customerName,
      tier: row.tier as Tier,
      seats: row.seats,
      sections: row.sections as LicensedSection[],
      features: row.features as Feature[],
      modelMode: row.modelMode === "managed" ? "managed" : "self",
      workspaceLimit: row.workspaceLimit,
      branding: row.accent ? { accent: row.accent } : null,
      checkInHours: row.checkInHours,
    };
    return signLicense(terms, { privateKey: keys.privateKey, kid: keys.kid, expiresAt: row.expiresAt });
  }

  async function audit(adminId: string | null, action: string, target: string | null, meta?: unknown) {
    await db.insert(adminAudit).values({ adminId, action, target, meta: meta ?? null });
  }

  async function requireAdmin(req: FastifyRequest) {
    const token = req.cookies[COOKIE];
    if (!token) throw new HttpError(401, "Sign in to continue.", "unauthorized");
    const [s] = await db
      .select({ adminId: adminSession.adminId, expiresAt: adminSession.expiresAt, email: adminUser.email, name: adminUser.name })
      .from(adminSession)
      .innerJoin(adminUser, eq(adminUser.id, adminSession.adminId))
      .where(eq(adminSession.id, sha256(token)));
    if (!s || s.expiresAt < new Date()) throw new HttpError(401, "Your session has ended. Sign in again.", "unauthorized");
    // Changes must come from the console itself (a custom header can't be sent cross-site without CORS).
    if (req.method !== "GET" && req.headers["x-aatmiq-console"] !== "1") throw new HttpError(403, "Requests must come from the console.", "csrf");
    return { id: s.adminId, email: s.email, name: s.name };
  }

  const setSessionCookie = (reply: FastifyReply, token: string | null) =>
    reply.setCookie(COOKIE, token ?? "", {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: cfg.consoleUrl.startsWith("https://"),
      maxAge: token ? SESSION_DAYS * 86400 : 0,
    });

  /* ───────────── Bootstrap ───────────── */

  if (cfg.bootstrapAdmin) {
    const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(adminUser)) as [{ n: number }];
    if (n === 0) {
      await db.insert(adminUser).values({ email: cfg.bootstrapAdmin.email, name: cfg.bootstrapAdmin.name, passwordHash: await hashPassword(cfg.bootstrapAdmin.password) });
    }
  }

  app.get("/v1/health", async () => ({ ok: true }));

  /* ───────────── Deployment check-in (public, authenticated by the license key itself) ───────────── */

  app.post("/v1/check-in", { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } }, async (req) => {
    const body = parse(checkInSchema, req.body);
    let kid: string | undefined;
    try {
      kid = decodeProtectedHeader(body.token).kid;
    } catch {
      throw new HttpError(400, "That isn't a license key.", "invalid_license");
    }
    const pub = kid ? keys.publicKeys.get(kid) : undefined;
    if (!pub) throw new HttpError(401, "This license key wasn't issued by this server.", "invalid_license");
    let claims;
    try {
      claims = await verifyLicense(body.token, pub);
    } catch (e) {
      throw new HttpError(401, e instanceof LicenseError ? e.message : "Invalid license key.", "invalid_license");
    }
    const [row] = await db.select().from(license).where(eq(license.id, claims.lid));
    if (!row) throw new HttpError(404, "This license no longer exists.", "unknown_license");

    await db.insert(checkIn).values({
      licenseId: row.id,
      instanceId: body.instanceId,
      version: body.version ?? null,
      activeSeats: body.activeSeats,
      usage: body.usage,
      health: body.health ?? null,
    });
    await db
      .update(license)
      .set({
        lastCheckInAt: new Date(),
        lastVersion: body.version ?? row.lastVersion,
        activeSeats: body.activeSeats,
        instanceId: row.instanceId ?? body.instanceId,
        instanceConflict: row.instanceConflict || (!!row.instanceId && row.instanceId !== body.instanceId),
      })
      .where(eq(license.id, row.id));

    if (row.status === "revoked") return { status: "revoked" as const };
    const [rel] = await db.select().from(setting).where(eq(setting.key, "release"));
    return { status: "active" as const, token: row.token, release: rel?.value ?? null, serverTime: new Date().toISOString() };
  });

  /* ───────────── Super Admin: sign in ───────────── */

  const failures = new Map<string, number[]>();
  app.post("/api/auth/login", { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } }, async (req, reply) => {
    const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1) }), req.body);
    const key = email.toLowerCase();
    const recent = (failures.get(key) ?? []).filter((t) => Date.now() - t < 15 * 60_000);
    if (recent.length >= 10) throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.", "too_many_attempts");
    const [a] = await db.select().from(adminUser).where(eq(adminUser.email, key));
    if (!a || !(await verifyPassword(password, a.passwordHash))) {
      failures.set(key, [...recent, Date.now()]);
      throw new HttpError(401, "Wrong email or password.", "invalid_credentials");
    }
    failures.delete(key);
    const token = randomToken();
    await db.insert(adminSession).values({ id: sha256(token), adminId: a.id, expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) });
    await db.update(adminUser).set({ lastLoginAt: new Date() }).where(eq(adminUser.id, a.id));
    await audit(a.id, "admin.login", null);
    setSessionCookie(reply, token);
    return { id: a.id, email: a.email, name: a.name };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    const token = req.cookies[COOKIE];
    if (token) await db.delete(adminSession).where(eq(adminSession.id, sha256(token)));
    setSessionCookie(reply, null);
    return { ok: true };
  });

  app.get("/api/me", async (req) => requireAdmin(req));

  /* ───────────── Overview ───────────── */

  app.get("/api/overview", async (req) => {
    await requireAdmin(req);
    const now = new Date();
    // Raw SQL parameters must be strings (Date objects aren't serialized there).
    const iso = (ms: number) => sql`${new Date(now.getTime() + ms).toISOString()}::timestamptz`;
    const in30 = iso(30 * 86400_000);
    const ago30 = iso(-30 * 86400_000);
    const ago3 = iso(-3 * 86400_000);
    const [totals] = await db
      .select({
        customers: sql<number>`(select count(*) from customer)::int`,
        activeLicenses: sql<number>`count(*) filter (where ${license.status} = 'active' and ${license.expiresAt} > now())::int`,
        seatsSold: sql<number>`coalesce(sum(${license.seats}) filter (where ${license.status} = 'active' and ${license.expiresAt} > now()), 0)::int`,
        seatsUsed: sql<number>`coalesce(sum(${license.activeSeats}) filter (where ${license.status} = 'active'), 0)::int`,
        expiringSoon: sql<number>`count(*) filter (where ${license.status} = 'active' and ${license.expiresAt} between now() and ${in30})::int`,
        silent: sql<number>`count(*) filter (where ${license.status} = 'active' and ${license.lastCheckInAt} is not null and ${license.lastCheckInAt} < ${ago3})::int`,
      })
      .from(license);
    const daily = (await db.execute(sql`
      select to_char(date_trunc('day', c.created_at), 'YYYY-MM-DD') as day,
             coalesce(sum((u->>'inputTokens')::bigint + (u->>'outputTokens')::bigint), 0)::bigint as tokens
      from check_in c left join lateral jsonb_array_elements(c.usage) u on true
      where c.created_at >= ${ago30}
      group by 1 order by 1`)) as unknown as { day: string; tokens: string }[];
    const attention = await db
      .select({ id: license.id, customerId: license.customerId, customer: customer.name, expiresAt: license.expiresAt, lastCheckInAt: license.lastCheckInAt, instanceConflict: license.instanceConflict, seats: license.seats, activeSeats: license.activeSeats })
      .from(license)
      .innerJoin(customer, eq(customer.id, license.customerId))
      .where(
        and(
          eq(license.status, "active"),
          sql`(${license.expiresAt} < ${in30} or ${license.instanceConflict} or (${license.lastCheckInAt} is not null and ${license.lastCheckInAt} < ${ago3}) or ${license.activeSeats} > ${license.seats})`,
        ),
      )
      .orderBy(license.expiresAt)
      .limit(20);
    return { ...totals, tokensDaily: daily.map((d) => ({ day: d.day, tokens: Number(d.tokens) })), attention };
  });

  /* ───────────── Customers ───────────── */

  const customerInput = z.object({
    name: z.string().trim().min(1).max(120),
    contactEmail: z.email().nullable().optional().or(z.literal("")),
    notes: z.string().max(4000).nullable().optional(),
  });

  app.get("/api/customers", async (req) => {
    await requireAdmin(req);
    const rows = await db
      .select({
        id: customer.id,
        name: customer.name,
        contactEmail: customer.contactEmail,
        createdAt: customer.createdAt,
        licenses: sql<number>`(select count(*) from license l where l.customer_id = "customer"."id")::int`,
        // Summary of the newest license.
        tier: sql<string | null>`(select l.tier from license l where l.customer_id = "customer"."id" order by l.created_at desc limit 1)`,
        seats: sql<number | null>`(select l.seats from license l where l.customer_id = "customer"."id" order by l.created_at desc limit 1)`,
        activeSeats: sql<number | null>`(select l.active_seats from license l where l.customer_id = "customer"."id" order by l.created_at desc limit 1)`,
        status: sql<string | null>`(select l.status::text from license l where l.customer_id = "customer"."id" order by l.created_at desc limit 1)`,
        expiresAt: sql<string | null>`(select l.expires_at from license l where l.customer_id = "customer"."id" order by l.created_at desc limit 1)`,
        lastCheckInAt: sql<string | null>`(select max(l.last_check_in_at) from license l where l.customer_id = "customer"."id")`,
      })
      .from(customer)
      .orderBy(customer.name);
    return rows;
  });

  app.post("/api/customers", async (req) => {
    const a = await requireAdmin(req);
    const body = parse(customerInput, req.body);
    const [c] = await db.insert(customer).values({ name: body.name, contactEmail: body.contactEmail || null, notes: body.notes ?? null }).returning();
    await audit(a.id, "customer.created", c!.id, { name: body.name });
    return c;
  });

  app.get<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    await requireAdmin(req);
    const [c] = await db.select().from(customer).where(eq(customer.id, req.params.id));
    if (!c) throw new HttpError(404, "Customer not found", "not_found");
    const licenses = await db.select().from(license).where(eq(license.customerId, c.id)).orderBy(desc(license.createdAt));
    const checkIns = licenses.length
      ? await db
          .select()
          .from(checkIn)
          .where(sql`${checkIn.licenseId} in ${licenses.map((l) => l.id)}`)
          .orderBy(desc(checkIn.createdAt))
          .limit(50)
      : [];
    return { ...c, licenses, checkIns };
  });

  app.patch<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    const a = await requireAdmin(req);
    const body = parse(customerInput.partial(), req.body);
    const [c] = await db
      .update(customer)
      .set({ ...body, contactEmail: body.contactEmail === undefined ? undefined : body.contactEmail || null })
      .where(eq(customer.id, req.params.id))
      .returning();
    if (!c) throw new HttpError(404, "Customer not found", "not_found");
    await audit(a.id, "customer.updated", c.id, body);
    // Customer name is part of the signed terms.
    if (body.name) for (const l of await db.select().from(license).where(eq(license.customerId, c.id))) await db.update(license).set({ token: await sign(l, c.name), issuedAt: new Date(), updatedAt: new Date() }).where(eq(license.id, l.id));
    return c;
  });

  app.delete<{ Params: { id: string } }>("/api/customers/:id", async (req) => {
    const a = await requireAdmin(req);
    const [c] = await db.select().from(customer).where(eq(customer.id, req.params.id));
    if (!c) throw new HttpError(404, "Customer not found", "not_found");
    const active = await db.select({ id: license.id }).from(license).where(and(eq(license.customerId, c.id), eq(license.status, "active")));
    if (active.length) throw new HttpError(409, "Revoke this customer's licenses before deleting it.", "has_licenses");
    await db.delete(customer).where(eq(customer.id, c.id));
    await audit(a.id, "customer.deleted", c.id, { name: c.name });
    return { ok: true };
  });

  /* ───────────── Licenses ───────────── */

  app.post<{ Params: { id: string } }>("/api/customers/:id/licenses", async (req) => {
    const a = await requireAdmin(req);
    const [c] = await db.select().from(customer).where(eq(customer.id, req.params.id));
    if (!c) throw new HttpError(404, "Customer not found", "not_found");
    const body = parse(licenseInput, req.body);
    if (body.expiresAt <= new Date()) throw new HttpError(400, "The expiry date must be in the future.", "invalid");
    const preset = TIERS[body.tier];
    const [row] = await db
      .insert(license)
      .values({
        customerId: c.id,
        tier: body.tier,
        seats: body.seats,
        sections: body.sections ?? [...preset.sections],
        features: body.features ?? [...preset.features],
        modelMode: body.modelMode,
        workspaceLimit: body.workspaceLimit === undefined ? preset.workspaceLimit : body.workspaceLimit,
        accent: body.accent ?? null,
        checkInHours: body.checkInHours,
        expiresAt: body.expiresAt,
        token: "pending",
        issuedAt: new Date(),
      })
      .returning();
    const token = await sign(row!, c.name);
    const [saved] = await db.update(license).set({ token }).where(eq(license.id, row!.id)).returning();
    await audit(a.id, "license.issued", saved!.id, { customer: c.name, tier: body.tier, seats: body.seats, expiresAt: body.expiresAt });
    return saved;
  });

  /** Change terms (seats, expiry, tier…). The key is re-signed; the deployment receives it at its next check-in. */
  app.patch<{ Params: { id: string } }>("/api/licenses/:id", async (req) => {
    const a = await requireAdmin(req);
    const [row] = await db.select().from(license).where(eq(license.id, req.params.id));
    if (!row) throw new HttpError(404, "License not found", "not_found");
    const body = parse(licenseInput.partial(), req.body);
    const next = { ...row };
    if (body.tier && body.tier !== row.tier) {
      const preset = TIERS[body.tier];
      next.tier = body.tier;
      next.sections = [...preset.sections];
      next.features = [...preset.features];
      next.workspaceLimit = preset.workspaceLimit;
    }
    if (body.seats !== undefined) next.seats = body.seats;
    if (body.expiresAt) next.expiresAt = body.expiresAt;
    if (body.sections) next.sections = body.sections;
    if (body.features) next.features = body.features;
    if (body.modelMode) next.modelMode = body.modelMode;
    if (body.workspaceLimit !== undefined) next.workspaceLimit = body.workspaceLimit;
    if (body.accent !== undefined) next.accent = body.accent;
    if (body.checkInHours !== undefined) next.checkInHours = body.checkInHours;
    const [c] = await db.select().from(customer).where(eq(customer.id, row.customerId));
    const token = await sign(next, c!.name);
    const [saved] = await db
      .update(license)
      .set({ ...next, token, issuedAt: new Date(), updatedAt: new Date() })
      .where(eq(license.id, row.id))
      .returning();
    await audit(a.id, "license.updated", row.id, body);
    return saved;
  });

  app.post<{ Params: { id: string } }>("/api/licenses/:id/revoke", async (req) => {
    const a = await requireAdmin(req);
    const [saved] = await db.update(license).set({ status: "revoked", updatedAt: new Date() }).where(eq(license.id, req.params.id)).returning();
    if (!saved) throw new HttpError(404, "License not found", "not_found");
    await audit(a.id, "license.revoked", saved.id);
    return saved;
  });

  app.post<{ Params: { id: string } }>("/api/licenses/:id/restore", async (req) => {
    const a = await requireAdmin(req);
    const [saved] = await db.update(license).set({ status: "active", updatedAt: new Date() }).where(eq(license.id, req.params.id)).returning();
    if (!saved) throw new HttpError(404, "License not found", "not_found");
    await audit(a.id, "license.restored", saved.id);
    return saved;
  });

  /** A new deployment for the same customer (e.g. after moving servers): clear the bound instance. */
  app.post<{ Params: { id: string } }>("/api/licenses/:id/reset-instance", async (req) => {
    const a = await requireAdmin(req);
    const [saved] = await db.update(license).set({ instanceId: null, instanceConflict: false }).where(eq(license.id, req.params.id)).returning();
    if (!saved) throw new HttpError(404, "License not found", "not_found");
    await audit(a.id, "license.instance_reset", saved.id);
    return saved;
  });

  /* ───────────── Settings & audit ───────────── */

  app.get("/api/settings", async (req) => {
    await requireAdmin(req);
    const [rel] = await db.select().from(setting).where(eq(setting.key, "release"));
    return { release: rel?.value ?? null, publicKeyPem: keys.publicPem, publicKey: publicKeyOneLine(keys.publicPem), kid: keys.kid };
  });

  app.put("/api/settings/release", async (req) => {
    const a = await requireAdmin(req);
    const body = parse(releaseSchema, req.body);
    const value = { version: body.version, notes: body.notes ?? null, url: body.url || null, publishedAt: new Date().toISOString() };
    await db.insert(setting).values({ key: "release", value }).onConflictDoUpdate({ target: setting.key, set: { value } });
    await audit(a.id, "release.published", null, value);
    return value;
  });

  app.get("/api/audit", async (req) => {
    await requireAdmin(req);
    return db
      .select({ id: adminAudit.id, action: adminAudit.action, target: adminAudit.target, meta: adminAudit.meta, createdAt: adminAudit.createdAt, admin: adminUser.email })
      .from(adminAudit)
      .leftJoin(adminUser, eq(adminUser.id, adminAudit.adminId))
      .orderBy(desc(adminAudit.createdAt))
      .limit(200);
  });

  /** Old sessions are cleaned up hourly. */
  const timer = setInterval(() => void db.delete(adminSession).where(lt(adminSession.expiresAt, new Date())).catch(() => {}), 3600_000);
  timer.unref();
  app.addHook("onClose", async () => clearInterval(timer));

  return app;
}
