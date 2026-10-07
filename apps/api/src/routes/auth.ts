import {
  and,
  eq,
  gte,
  invitation,
  isNull,
  model,
  modelProvider,
  organization,
  sql,
  user,
  workspace,
  workspaceMember,
  workspaceModel,
} from "@aatmiq/db";
import { acceptInviteSchema, DEFAULT_ACCENT, PRODUCT_NAME, setupSchema } from "@aatmiq/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyInstance, FastifyReply } from "fastify";
import { VERIFY_CALLBACK } from "../auth";
import { audit, getOrg, parse, type AppContext } from "../context";
import { sha256 } from "../crypto";
import { logoHeaders, logoUrl } from "../services/branding";
import { badRequest, conflict, HttpError, notFound } from "../errors";

function forwardCookies(reply: FastifyReply, headers: Headers) {
  const cookies = headers.getSetCookie();
  if (cookies.length) reply.header("set-cookie", cookies);
}

/** Failed sign-ins per account: 10 per 15 minutes (brute-force protection that doesn't punish shared office IPs). */
const FAIL_WINDOW_MS = 15 * 60_000;
const FAIL_MAX = 10;
const failedSignIns = new Map<string, number[]>();

function recentFailures(email: string, now = Date.now()): number[] {
  const list = (failedSignIns.get(email) ?? []).filter((t) => now - t < FAIL_WINDOW_MS);
  if (list.length) failedSignIns.set(email, list);
  else failedSignIns.delete(email);
  return list;
}

export async function authRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, auth, cfg } = ctx;

  /** Better Auth endpoints (sign-in, sign-out, session…). Public sign-up is disabled: accounts come from setup or invites. */
  app.route({
    method: ["GET", "POST"],
    url: "/api/auth/*",
    config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
    async handler(req, reply) {
      if (req.url.startsWith("/api/auth/sign-up")) {
        throw new HttpError(403, "Accounts are created by invitation. Ask your admin for an invite.", "signup_disabled");
      }
      // Confirmation emails go out only through POST /api/me/email/verify (signed in, rate limited).
      if (req.url.startsWith("/api/auth/send-verification-email")) {
        throw new HttpError(403, "Sign in to get a new confirmation link.", "forbidden");
      }
      if (req.method === "POST" && req.url.startsWith("/api/auth/two-factor/disable") && (await getOrg(db))?.twoFactorRequired) {
        throw new HttpError(403, "Your organization requires two-step sign-in, so it can't be turned off.", "two_factor_required");
      }
      if (req.method === "POST" && req.url.startsWith("/api/auth/request-password-reset") && !(await ctx.mail.configured())) {
        throw new HttpError(503, "Email isn't set up on this server, so we can't send a reset link. Ask your admin for one.", "email_off");
      }
      const isSignIn = req.method === "POST" && req.url.startsWith("/api/auth/sign-in/email");
      const email = isSignIn ? String((req.body as { email?: unknown } | undefined)?.email ?? "").toLowerCase() : "";
      if (isSignIn && email && recentFailures(email).length >= FAIL_MAX) {
        throw new HttpError(429, "Too many failed sign-in attempts for this account. Try again in 15 minutes.", "too_many_attempts");
      }
      // With single sign-on required, only the owner keeps a password (so the org can't lock itself out).
      if (isSignIn && email) {
        const org = await getOrg(db);
        if (org?.ssoRequired) {
          const [who] = await db.select({ orgRole: user.orgRole }).from(user).where(eq(sql`lower(${user.email})`, email));
          if (who?.orgRole !== "owner") throw new HttpError(403, "Your organization signs in with single sign-on. Use the button below.", "sso_required");
        }
      }
      const url = new URL(req.url, cfg.appUrl);
      const res = await auth.handler(
        new Request(url, {
          method: req.method,
          headers: fromNodeHeaders(req.headers),
          body: req.method === "GET" || req.body === undefined ? undefined : JSON.stringify(req.body),
        }),
      );
      if (isSignIn && email) {
        if (res.status === 401) failedSignIns.set(email, [...recentFailures(email), Date.now()]);
        else if (res.ok) failedSignIns.delete(email);
      }
      reply.status(res.status);
      res.headers.forEach((v, k) => {
        if (k !== "set-cookie" && k !== "content-length") reply.header(k, v);
      });
      forwardCookies(reply, res.headers);
      return reply.send(res.body ? await res.text() : null);
    },
  });

  /** Sends a confirmation link in the background when email is set up; failures only reach the log. */
  function sendConfirmation(email: string) {
    void (async () => {
      if (!(await ctx.mail.configured())) return;
      await auth.api.sendVerificationEmail({ body: { email, callbackURL: VERIFY_CALLBACK } });
    })().catch((e: Error) => app.log.warn({ err: e.message }, "confirmation email failed"));
  }

  /** Public: install status + branding for the login page. */
  app.get("/api/public/status", async () => {
    const org = await getOrg(db);
    return {
      setupRequired: !org,
      licenseRequired: ctx.license.required,
      ssoRequired: org?.ssoRequired ?? false,
      org: org
        ? {
            name: org.name,
            productName: org.productName ?? PRODUCT_NAME,
            accentColor: org.accentColor ?? DEFAULT_ACCENT,
            loginMessage: org.loginMessage,
            logoUrl: logoUrl(org.logo),
          }
        : { name: null, productName: PRODUCT_NAME, accentColor: DEFAULT_ACCENT, loginMessage: null, logoUrl: null },
    };
  });

  /** Public: the organization's logo (the sign-in page shows it before anyone signs in). */
  app.get<{ Querystring: { v?: string } }>("/api/public/logo", async (req, reply) => {
    const logo = (await getOrg(db))?.logo;
    if (!logo) throw notFound("No logo");
    const data = await ctx.storage.get(logo.key).catch(() => null);
    if (!data) throw notFound("No logo");
    return reply.headers(logoHeaders(logo.type, req.query.v === logo.version)).send(data);
  });

  /** First-run setup: org + owner + default workspace (+ demo model in dev). */
  app.post("/api/setup", { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } }, async (req, reply) => {
    const body = parse(setupSchema, req.body);
    if (await getOrg(db)) throw conflict("Aatmiq is already set up on this server.");
    // With a public key configured, a genuine license is needed to set up.
    const claims = ctx.license.required
      ? body.licenseKey
        ? await ctx.license.verifyOrThrow(body.licenseKey)
        : (() => {
            throw badRequest("Enter your license key to set up Aatmiq.");
          })()
      : null;

    const [org] = await db
      .insert(organization)
      .values({
        name: body.orgName,
        accentColor: body.accentColor ?? claims?.branding?.accent ?? DEFAULT_ACCENT,
        licenseKey: claims ? body.licenseKey!.trim() : null,
      })
      .returning();

    const { headers, response } = await auth.api.signUpEmail({
      body: { email: body.email, password: body.password, name: body.name },
      returnHeaders: true,
    });
    const ownerId = response.user.id;
    // The address is only typed in here, so it isn't confirmed until the link in the email is used.
    await db.update(user).set({ orgRole: "owner" }).where(eq(user.id, ownerId));

    const [ws] = await db.insert(workspace).values({ name: "General", icon: "✦" }).returning();
    await db.insert(workspaceMember).values({
      workspaceId: ws!.id,
      userId: ownerId,
      role: "admin",
      sections: ["chat", "work", "code"],
    });

    if (cfg.allowMockProvider) {
      const [p] = await db
        .insert(modelProvider)
        .values({ name: "Aatmiq Demo", type: "mock", health: { ok: true, latencyMs: 0, checkedAt: new Date().toISOString() } })
        .returning();
      const [m] = await db
        .insert(model)
        .values({ providerId: p!.id, modelKey: "aatmiq-demo", displayName: "Aatmiq Demo", contextLength: 32768 })
        .returning();
      const [e] = await db
        .insert(model)
        .values({ providerId: p!.id, modelKey: "aatmiq-embed", displayName: "Aatmiq Demo Embeddings", kind: "embedding", sections: [] })
        .returning();
      await db.insert(workspaceModel).values({ workspaceId: ws!.id, modelId: m!.id });
      await db.update(workspace).set({ defaultModelId: m!.id, embeddingModelId: e!.id }).where(eq(workspace.id, ws!.id));
    }

    await audit(ctx, {
      actor: { id: ownerId, email: body.email, name: body.name, image: null, orgRole: "owner" },
      action: "org.setup",
      targetType: "organization",
      targetId: org!.id,
      ip: req.ip,
    });
    forwardCookies(reply, headers);
    sendConfirmation(body.email);
    if (claims) void ctx.license.checkIn().catch(() => {});
    return { ok: true };
  });

  async function findInvite(token: string) {
    const [inv] = await db
      .select()
      .from(invitation)
      .where(
        and(
          eq(invitation.tokenHash, sha256(token)),
          isNull(invitation.acceptedAt),
          isNull(invitation.revokedAt),
          gte(invitation.expiresAt, new Date()),
        ),
      );
    if (!inv) throw notFound("This invitation link is invalid or has expired.");
    return inv;
  }

  app.get<{ Params: { token: string } }>("/api/invites/:token", async (req) => {
    const inv = await findInvite(req.params.token);
    const org = await getOrg(db);
    return { email: inv.email, orgName: org?.name ?? "", productName: org?.productName ?? PRODUCT_NAME };
  });

  app.post<{ Params: { token: string } }>(
    "/api/invites/:token/accept",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = parse(acceptInviteSchema, req.body);
      const inv = await findInvite(req.params.token);
      if ((await getOrg(db))?.ssoRequired) throw new HttpError(403, "Your organization signs in with single sign-on. Use the button above.", "sso_required");
      const [existing] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(user)
        .where(eq(sql`lower(${user.email})`, inv.email.toLowerCase()));
      if (existing && existing.n > 0) throw conflict("An account with this email already exists. Please sign in.");

      const { headers, response } = await auth.api
        .signUpEmail({ body: { email: inv.email, password: body.password, name: body.name }, returnHeaders: true })
        .catch((e: unknown) => {
          throw badRequest(e instanceof Error ? e.message : "Could not create account");
        });
      const uid = response.user.id;
      // An emailed invitation proves the address; a link the admin passed on some other way doesn't.
      await db.update(user).set({ orgRole: inv.orgRole, emailVerified: inv.emailed }).where(eq(user.id, uid));
      for (const w of inv.workspaces) {
        await db
          .insert(workspaceMember)
          .values({ workspaceId: w.workspaceId, userId: uid, role: w.role, sections: ["chat", "work", "code"] })
          .onConflictDoNothing();
      }
      await db.update(invitation).set({ acceptedAt: new Date() }).where(eq(invitation.id, inv.id));
      await audit(ctx, {
        actor: { id: uid, email: inv.email, name: body.name, image: null, orgRole: inv.orgRole },
        action: "user.invite_accepted",
        targetType: "user",
        targetId: uid,
        ip: req.ip,
      });
      forwardCookies(reply, headers);
      if (!inv.emailed) sendConfirmation(inv.email);
      return { ok: true };
    },
  );
}
