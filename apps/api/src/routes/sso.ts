import { account, and, asc, eq, gte, invitation, isNull, organization, sql, ssoConnection, user, workspace, workspaceMember } from "@aatmiq/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";
import { PRODUCT_NAME } from "@aatmiq/shared";
import { z } from "zod";
import { ssoTicketId } from "../auth";
import { audit, getOrg, notify, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { randomToken, sha256 } from "../crypto";
import { badRequest, HttpError, notFound } from "../errors";
import {
  authorizationUrl,
  clearSsoCaches,
  completeSignIn,
  discover,
  emailDomainAllowed,
  GOOGLE_ISSUER,
  microsoftIssuer,
  newAuthRequest,
  SsoError,
} from "../services/sso";

const STATE_COOKIE = "aatmiq_sso";
const STATE_TTL_MS = 10 * 60_000;

const domainList = z
  .array(z.string().trim().toLowerCase().transform((d) => d.replace(/^@/, "")))
  .max(50)
  .refine((ds) => ds.every((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)), "Enter domains like example.com");

const connectionInput = z.object({
  type: z.enum(["google", "microsoft", "oidc"]),
  name: z.string().trim().min(1).max(60).optional(),
  issuer: z.string().trim().optional(),
  tenantId: z.string().trim().optional(),
  clientId: z.string().trim().min(1).max(500),
  clientSecret: z.string().trim().min(1).max(2000),
  domains: domainList.default([]),
  autoJoin: z.boolean().default(false),
  defaultWorkspaceId: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});
// No defaults here: a partial update must leave untouched fields as they are.
const connectionUpdate = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  issuer: z.string().trim().optional(),
  tenantId: z.string().trim().optional(),
  clientId: z.string().trim().min(1).max(500).optional(),
  clientSecret: z.string().trim().min(1).max(2000).optional(),
  domains: domainList.optional(),
  autoJoin: z.boolean().optional(),
  defaultWorkspaceId: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
});

const BROAD_TENANTS = new Set(["common", "organizations", "consumers"]);

function issuerFor(type: "google" | "microsoft" | "oidc", input: { issuer?: string; tenantId?: string }) {
  if (type === "google") return GOOGLE_ISSUER;
  if (type === "microsoft") {
    const t = input.tenantId?.trim() ?? "";
    if (!t) throw badRequest("Enter your Microsoft Entra directory (tenant) ID.");
    // Multi-tenant endpoints would let any Microsoft directory vouch for any email address.
    if (BROAD_TENANTS.has(t.toLowerCase())) throw badRequest("Use your organization's own directory (tenant) ID, not “common” or “organizations”.");
    if (!/^[a-zA-Z0-9.-]+$/.test(t)) throw badRequest("That doesn't look like a directory (tenant) ID.");
    return microsoftIssuer(t);
  }
  const iss = input.issuer?.trim().replace(/\/$/, "") ?? "";
  let u: URL;
  try {
    u = new URL(iss);
  } catch {
    throw badRequest("Enter the issuer URL, e.g. https://acme.okta.com");
  }
  const local = ["localhost", "127.0.0.1"].includes(u.hostname);
  if (u.protocol !== "https:" && !local) throw badRequest("The issuer URL must use https.");
  return iss;
}

const DEFAULT_NAME = { google: "Google", microsoft: "Microsoft", oidc: "Single sign-on" } as const;
const FEATURE_FOR = { google: "sso", microsoft: "sso", oidc: "oidc" } as const;

function readCookie(req: FastifyRequest, name: string) {
  const m = new RegExp(`(?:^|;\\s*)${name}=([^;]+)`).exec(req.headers.cookie ?? "");
  return m ? decodeURIComponent(m[1]!) : null;
}

export async function ssoRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, cfg, license } = ctx;
  const redirectUri = `${cfg.appUrl}/api/auth/sso/callback`;
  const secure = cfg.appUrl.startsWith("https://");
  const stateCookie = (value: string, maxAge: number) =>
    `${STATE_COOKIE}=${encodeURIComponent(value)}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;

  const publicConn = (c: typeof ssoConnection.$inferSelect) => {
    const { clientSecretEnc: _s, ...rest } = c;
    return rest;
  };

  /* ───────────── Sign-in flow ───────────── */

  function fail(reply: FastifyReply, message: string, invite?: string | null) {
    const target = invite ? `/invite/${encodeURIComponent(invite)}` : "/login";
    return reply.header("set-cookie", stateCookie("", 0)).redirect(`${target}?sso_error=${encodeURIComponent(message)}`);
  }

  app.get<{ Params: { id: string }; Querystring: { next?: string; invite?: string; email?: string } }>("/api/auth/sso/:id/start", async (req, reply) => {
    const [conn] = await db.select().from(ssoConnection).where(eq(ssoConnection.id, req.params.id));
    const invite = req.query.invite ?? null;
    if (!conn || !conn.enabled) return fail(reply, "This sign-in option isn't available.", invite);
    if (!(await license.hasFeature(FEATURE_FOR[conn.type]))) return fail(reply, "Single sign-on isn't included in your organization's license.", invite);
    const r = newAuthRequest();
    let url: string;
    try {
      url = await authorizationUrl(conn, { redirectUri, state: r.state, nonce: r.nonce, challenge: r.challenge, loginHint: req.query.email });
    } catch (e) {
      return fail(reply, e instanceof SsoError ? e.message : "Couldn't start single sign-on.", invite);
    }
    const next = req.query.next && /^\/(?!\/)/.test(req.query.next) ? req.query.next : "/app";
    const sealed = box.encrypt(JSON.stringify({ ...r, connId: conn.id, next, invite, exp: Date.now() + STATE_TTL_MS }));
    return reply.header("set-cookie", stateCookie(sealed, STATE_TTL_MS / 1000)).redirect(url);
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string; error_description?: string } }>("/api/auth/sso/callback", async (req, reply) => {
    let st: { state: string; nonce: string; verifier: string; connId: string; next: string; invite: string | null; exp: number };
    try {
      st = JSON.parse(box.decrypt(readCookie(req, STATE_COOKIE) ?? ""));
    } catch {
      return fail(reply, "Your sign-in session expired. Please try again.");
    }
    if (st.exp < Date.now() || !req.query.state || req.query.state !== st.state) return fail(reply, "Your sign-in session expired. Please try again.", st.invite);
    if (req.query.error) return fail(reply, req.query.error_description || "Sign-in was cancelled.", st.invite);
    if (!req.query.code) return fail(reply, "The provider didn't complete the sign-in.", st.invite);

    const [conn] = await db.select().from(ssoConnection).where(eq(ssoConnection.id, st.connId));
    if (!conn || !conn.enabled) return fail(reply, "This sign-in option isn't available.", st.invite);

    let identity;
    try {
      identity = await completeSignIn(conn, box.decrypt(conn.clientSecretEnc), { code: req.query.code, verifier: st.verifier, nonce: st.nonce, redirectUri });
    } catch (e) {
      req.log.warn({ err: e }, "sso sign-in failed");
      return fail(reply, e instanceof SsoError ? e.message : "Single sign-on failed.", st.invite);
    }
    if (!emailDomainAllowed(conn, identity.email))
      return fail(reply, `${identity.email} can't sign in here. Use your ${conn.domains.join(" or ")} account.`, st.invite);

    const providerId = `sso:${conn.id}`;
    let userId: string | null = null;
    let created = false;

    // 1. Signed in with this provider before.
    const [linked] = await db
      .select({ userId: account.userId })
      .from(account)
      .where(and(eq(account.providerId, providerId), eq(account.accountId, identity.subject)));
    if (linked) userId = linked.userId;

    // 2. An existing account with the same email (password or another provider): link it.
    if (!userId) {
      const [existing] = await db.select({ id: user.id }).from(user).where(eq(sql`lower(${user.email})`, identity.email));
      if (existing) userId = existing.id;
    }

    // 3. A pending invitation for this email, or 4. auto-join for an allowed domain.
    if (!userId) {
      const [inv] = await db
        .select()
        .from(invitation)
        .where(and(eq(invitation.email, identity.email), isNull(invitation.acceptedAt), isNull(invitation.revokedAt), gte(invitation.expiresAt, new Date())));
      if (inv) {
        userId = await createUser(identity.email, identity.name, inv.orgRole);
        for (const w of inv.workspaces)
          await db.insert(workspaceMember).values({ workspaceId: w.workspaceId, userId, role: w.role, sections: ["chat", "work", "code"] }).onConflictDoNothing();
        await db.update(invitation).set({ acceptedAt: new Date() }).where(eq(invitation.id, inv.id));
        created = true;
      } else if (conn.autoJoin && conn.domains.length) {
        try {
          await license.requireSeats(1);
        } catch (e) {
          return fail(reply, e instanceof HttpError ? e.message : "No seats are left.", st.invite);
        }
        userId = await createUser(identity.email, identity.name, "member");
        const [ws] = conn.defaultWorkspaceId
          ? await db.select({ id: workspace.id }).from(workspace).where(and(eq(workspace.id, conn.defaultWorkspaceId), isNull(workspace.archivedAt)))
          : await db.select({ id: workspace.id }).from(workspace).where(isNull(workspace.archivedAt)).orderBy(asc(workspace.createdAt)).limit(1);
        if (ws) await db.insert(workspaceMember).values({ workspaceId: ws.id, userId, role: "member", sections: ["chat", "work", "code"] }).onConflictDoNothing();
        created = true;
      } else {
        return fail(reply, `There's no account for ${identity.email} yet. Ask your admin for an invitation.`, st.invite);
      }
    }

    const [u] = await db.select({ id: user.id, status: user.status, name: user.name, orgRole: user.orgRole }).from(user).where(eq(user.id, userId));
    if (!u || u.status !== "active") return fail(reply, "Your account is deactivated. Ask your admin for help.", st.invite);

    if (!linked) {
      await db
        .insert(account)
        .values({ id: randomUUID(), userId: u.id, providerId, accountId: identity.subject, createdAt: new Date(), updatedAt: new Date() })
        .onConflictDoNothing();
    }
    const actor = { id: u.id, email: identity.email, name: u.name, image: null, orgRole: u.orgRole };
    if (created) await audit(ctx, { actor, action: "user.sso_created", targetType: "user", targetId: u.id, meta: { connection: conn.name }, ip: req.ip });
    await audit(ctx, { actor, action: "auth.sso_login", targetType: "sso_connection", targetId: conn.id, meta: { connection: conn.name }, ip: req.ip });

    const ticket = randomToken();
    const actx = await ctx.auth.$context;
    await actx.internalAdapter.createVerificationValue({ identifier: ssoTicketId(sha256(ticket)), value: u.id, expiresAt: new Date(Date.now() + 2 * 60_000) });
    return reply
      .header("set-cookie", stateCookie("", 0))
      .redirect(`/api/auth/sso/ticket?ticket=${encodeURIComponent(ticket)}&next=${encodeURIComponent(st.next)}`);
  });

  async function createUser(email: string, name: string, orgRole: "owner" | "admin" | "member") {
    const id = randomUUID();
    await db.insert(user).values({ id, email, name, emailVerified: true, orgRole, createdAt: new Date(), updatedAt: new Date() });
    return id;
  }

  /* ───────────── Admin: Authentication ───────────── */

  /** Active people who sign in with a password but haven't set up two-step sign-in. */
  async function withoutTwoStep(ssoRequired: boolean) {
    const rows = await db
      .select({ id: user.id, orgRole: user.orgRole })
      .from(user)
      .where(
        and(
          eq(user.status, "active"),
          eq(user.twoFactorEnabled, false),
          sql`exists (select 1 from ${account} where ${account.userId} = ${sql.raw(`"user"."id"`)} and ${account.providerId} = 'credential')`,
        ),
      );
    return rows.filter((r) => !ssoRequired || r.orgRole === "owner");
  }

  async function authSettings() {
    const org = await getOrg(db);
    const connections = await db.select().from(ssoConnection).orderBy(asc(ssoConnection.createdAt));
    return {
      ssoRequired: org?.ssoRequired ?? false,
      twoFactorRequired: org?.twoFactorRequired ?? false,
      twoFactorDeadline: org?.twoFactorRequired && org.twoFactorDeadline && org.twoFactorDeadline > new Date() ? org.twoFactorDeadline.toISOString() : null,
      withoutTwoStep: (await withoutTwoStep(org?.ssoRequired ?? false)).length,
      redirectUri,
      connections: connections.map(publicConn),
      features: { sso: await license.hasFeature("sso"), oidc: await license.hasFeature("oidc") },
    };
  }

  app.get("/api/admin/auth", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    return authSettings();
  });

  app.put("/api/admin/auth", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const body = parse(
      z.object({
        ssoRequired: z.boolean().optional(),
        twoFactorRequired: z.boolean().optional(),
        /** Days people without two-step sign-in may keep working (with reminders) before it's enforced. */
        twoFactorGraceDays: z.number().int().min(0).max(30).optional(),
      }),
      req.body,
    );
    const org = await getOrg(db);
    if (body.ssoRequired !== undefined) {
      const { ssoRequired } = body;
      if (ssoRequired) {
        const live = await db.select({ id: ssoConnection.id }).from(ssoConnection).where(eq(ssoConnection.enabled, true));
        if (!live.length) throw badRequest("Add and enable a sign-in provider before requiring single sign-on.");
      }
      await db.update(organization).set({ ssoRequired }).where(eq(organization.id, org!.id));
      await audit(ctx, { actor: u, action: ssoRequired ? "auth.sso_required_on" : "auth.sso_required_off", targetType: "organization", targetId: org!.id });
    }
    if (body.twoFactorRequired !== undefined) {
      const { twoFactorRequired } = body;
      // The admin goes first, so turning the rule on never locks them out of this page.
      if (twoFactorRequired && (await withoutTwoStep(org?.ssoRequired ?? false)).some((r) => r.id === u.id)) {
        throw badRequest("Set up two-step sign-in for your own account first (Settings → Security).");
      }
      const graceDays = twoFactorRequired ? (body.twoFactorGraceDays ?? 0) : 0;
      const deadline = twoFactorRequired && graceDays > 0 ? new Date(Date.now() + graceDays * 86_400_000) : null;
      await db.update(organization).set({ twoFactorRequired, twoFactorDeadline: deadline }).where(eq(organization.id, org!.id));
      await audit(ctx, {
        actor: u,
        action: twoFactorRequired ? "auth.two_factor_required_on" : "auth.two_factor_required_off",
        targetType: "organization",
        targetId: org!.id,
        ...(twoFactorRequired ? { meta: { graceDays, deadline: deadline?.toISOString() ?? null } } : {}),
      });
      if (twoFactorRequired && !org?.twoFactorRequired) {
        // Tell the people it affects, with the date (or that they'll be asked at their next visit).
        const people = (await withoutTwoStep(org?.ssoRequired ?? false)).map((r) => r.id).filter((id) => id !== u.id);
        const when = deadline ? deadline.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : null;
        await notify(db, people, {
          type: "security",
          title: when ? `Set up two-step sign-in by ${when}` : "Two-step sign-in is now required",
          body: when
            ? `Your organization requires two-step sign-in from ${when}. Set it up in Settings → Security; it takes a minute with an authenticator app.`
            : "Your organization now requires two-step sign-in: you'll be asked to set it up before you continue.",
          link: "/app/settings#security",
        });
      }
    }
    return authSettings();
  });

  async function requireFeatureFor(type: "google" | "microsoft" | "oidc") {
    if (!(await license.hasFeature(FEATURE_FOR[type])))
      throw new HttpError(402, type === "oidc" ? "Custom single sign-on is part of the Enterprise plan." : "Google and Microsoft sign-in aren't included in your license.", "feature_unavailable");
  }

  async function checkWorkspace(id: string | null | undefined) {
    if (!id) return;
    const [w] = await db.select({ id: workspace.id }).from(workspace).where(eq(workspace.id, id));
    if (!w) throw badRequest("Unknown workspace");
  }

  app.post("/api/admin/sso", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const body = parse(connectionInput, req.body);
    await requireFeatureFor(body.type);
    if (body.autoJoin && !body.domains.length) throw badRequest("List your email domains to let people join automatically.");
    await checkWorkspace(body.defaultWorkspaceId);
    const [c] = await db
      .insert(ssoConnection)
      .values({
        type: body.type,
        name: body.name || DEFAULT_NAME[body.type],
        issuer: issuerFor(body.type, body),
        tenantId: body.type === "microsoft" ? body.tenantId!.trim() : null,
        clientId: body.clientId,
        clientSecretEnc: box.encrypt(body.clientSecret),
        domains: body.domains,
        autoJoin: body.autoJoin,
        defaultWorkspaceId: body.defaultWorkspaceId ?? null,
        enabled: body.enabled,
      })
      .returning();
    await audit(ctx, { actor: u, action: "auth.sso_added", targetType: "sso_connection", targetId: c!.id, meta: { type: c!.type, name: c!.name, domains: c!.domains } });
    return publicConn(c!);
  });

  app.patch<{ Params: { id: string } }>("/api/admin/sso/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const [c] = await db.select().from(ssoConnection).where(eq(ssoConnection.id, req.params.id));
    if (!c) throw notFound("Sign-in provider not found");
    const body = parse(connectionUpdate, req.body);
    if (body.enabled) await requireFeatureFor(c.type);
    const domains = body.domains ?? c.domains;
    const autoJoin = body.autoJoin ?? c.autoJoin;
    if (autoJoin && !domains.length) throw badRequest("List your email domains to let people join automatically.");
    await checkWorkspace(body.defaultWorkspaceId);
    const [saved] = await db
      .update(ssoConnection)
      .set({
        name: body.name,
        clientId: body.clientId,
        ...(body.clientSecret ? { clientSecretEnc: box.encrypt(body.clientSecret) } : {}),
        ...(body.issuer !== undefined || body.tenantId !== undefined
          ? { issuer: issuerFor(c.type, { issuer: body.issuer ?? c.issuer, tenantId: body.tenantId ?? c.tenantId ?? undefined }), tenantId: c.type === "microsoft" ? (body.tenantId ?? c.tenantId) : null }
          : {}),
        domains,
        autoJoin,
        defaultWorkspaceId: body.defaultWorkspaceId,
        enabled: body.enabled,
        updatedAt: new Date(),
      })
      .where(eq(ssoConnection.id, c.id))
      .returning();
    // Turning off the last provider also turns off "require SSO", so nobody is locked out.
    const live = await db.select({ id: ssoConnection.id }).from(ssoConnection).where(eq(ssoConnection.enabled, true));
    if (!live.length) await db.update(organization).set({ ssoRequired: false });
    clearSsoCaches();
    await audit(ctx, { actor: u, action: "auth.sso_updated", targetType: "sso_connection", targetId: c.id, meta: { ...body, clientSecret: body.clientSecret ? "(changed)" : undefined } });
    return publicConn(saved!);
  });

  app.delete<{ Params: { id: string } }>("/api/admin/sso/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const [c] = await db.delete(ssoConnection).where(eq(ssoConnection.id, req.params.id)).returning();
    if (!c) throw notFound("Sign-in provider not found");
    const live = await db.select({ id: ssoConnection.id }).from(ssoConnection).where(eq(ssoConnection.enabled, true));
    if (!live.length) await db.update(organization).set({ ssoRequired: false });
    await audit(ctx, { actor: u, action: "auth.sso_removed", targetType: "sso_connection", targetId: c.id, meta: { name: c.name } });
    return { ok: true };
  });

  /** Check the provider's configuration is reachable (the client secret is checked at the first sign-in). */
  app.post<{ Params: { id: string } }>("/api/admin/sso/:id/test", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const [c] = await db.select().from(ssoConnection).where(eq(ssoConnection.id, req.params.id));
    if (!c) throw notFound("Sign-in provider not found");
    clearSsoCaches();
    try {
      const d = await discover(c.issuer);
      return { ok: true, issuer: d.issuer, message: `Reached ${new URL(d.authorization_endpoint).host}.` };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : "Couldn't reach the provider." };
    }
  });

  /**
   * For the desktop app (apps/desktop): that this is Aatmiq, and where its windows may go: the app,
   * the IDE's own host, and the identity providers sign-in sends people to.
   */
  app.get("/api/public/desktop", async () => {
    const org = await getOrg(db);
    const conns = await db.select({ type: ssoConnection.type, issuer: ssoConnection.issuer }).from(ssoConnection).where(eq(ssoConnection.enabled, true));
    // The issuer, and its authorization endpoint, which may live elsewhere (best effort: cached,
    // and an unreachable provider doesn't hold the answer up).
    const found = await Promise.all(
      conns.map(async (c) => {
        const d = await Promise.race([discover(c.issuer).catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 4000).unref())]);
        return [c.issuer, d?.authorization_endpoint].flatMap((u) => {
          try {
            return u ? [new URL(u).origin] : [];
          } catch {
            return [];
          }
        });
      }),
    );
    const signIn = new Set(found.flat());
    return {
      product: "aatmiq",
      name: org?.productName ?? PRODUCT_NAME,
      appOrigin: new URL(ctx.cfg.appUrl).origin,
      ideOrigin: ctx.cfg.ideUrl ? new URL(ctx.cfg.ideUrl).origin : null,
      signInOrigins: [...signIn],
    };
  });

  /** For the sign-in page: which buttons to show. */
  app.get("/api/public/sso", async () => {
    const conns = await db
      .select({ id: ssoConnection.id, type: ssoConnection.type, name: ssoConnection.name })
      .from(ssoConnection)
      .where(eq(ssoConnection.enabled, true))
      .orderBy(asc(ssoConnection.createdAt));
    const allowed = [];
    for (const c of conns) if (await license.hasFeature(FEATURE_FOR[c.type])) allowed.push(c);
    return allowed;
  });
}
