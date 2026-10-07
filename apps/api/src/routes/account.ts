/**
 * Account security and outgoing email:
 * - a person's own sign-in settings (password, two-step sign-in),
 * - admin help when someone is locked out (reset link, turning off two-step sign-in),
 * - Admin → Settings → Email (the SMTP server for invitations and resets).
 */
import { account, and, eq, organization, session, twoFactor, user } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { fromNodeHeaders } from "better-auth/node";
import { RESET_LINK_MINUTES, VERIFY_CALLBACK, VERIFY_LINK_HOURS } from "../auth";
import { audit, getOrg, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { randomToken } from "../crypto";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import type { MailServer } from "../services/mail";

const emailSchema = z.object({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(["tls", "starttls", "none"]),
  username: z.string().trim().max(320).nullable().optional(),
  /** Omitted: keep the saved password. Empty: no password. */
  password: z.string().max(1000).optional(),
  from: z.string().trim().min(3).max(320),
});

export async function accountRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, cfg } = ctx;

  /* ───────────── Your own sign-in ───────────── */

  app.get("/api/me/security", async (req) => {
    const u = await requireUser(ctx, req);
    const [row] = await db.select({ twoFactorEnabled: user.twoFactorEnabled, emailVerified: user.emailVerified }).from(user).where(eq(user.id, u.id));
    const [cred] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, u.id), eq(account.providerId, "credential")));
    const org = await getOrg(db);
    const passwordAllowed = !org?.ssoRequired || u.orgRole === "owner";
    const sessions = await db.select({ id: session.id }).from(session).where(eq(session.userId, u.id));
    return {
      hasPassword: !!cred,
      passwordAllowed,
      twoFactorEnabled: row?.twoFactorEnabled ?? false,
      twoFactorRequired: org?.twoFactorRequired ?? false,
      email: u.email,
      emailVerified: row?.emailVerified ?? false,
      otherSessions: Math.max(0, sessions.length - 1),
      emailEnabled: await ctx.mail.configured(),
    };
  });

  /** Emails a link that confirms the person's address (Better Auth marks it confirmed when opened). */
  app.post("/api/me/email/verify", { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } }, async (req) => {
    const u = await requireUser(ctx, req);
    const [row] = await db.select({ emailVerified: user.emailVerified }).from(user).where(eq(user.id, u.id));
    if (row?.emailVerified) return { ok: true, alreadyVerified: true };
    if (!(await ctx.mail.configured())) throw new HttpError(503, "Email isn't set up on this server yet. Ask your admin.", "email_off");
    try {
      await ctx.auth.api.sendVerificationEmail({ body: { email: u.email, callbackURL: VERIFY_CALLBACK }, headers: fromNodeHeaders(req.headers) });
    } catch (e) {
      throw new HttpError(502, `The email couldn't be sent: ${(e as Error).message}`, "email_failed");
    }
    return { ok: true, to: u.email, expiresInHours: VERIFY_LINK_HOURS };
  });

  /* ───────────── Admin help for locked-out people ───────────── */

  async function target(actorId: string, id: string) {
    const [t] = await db.select().from(user).where(eq(user.id, id));
    if (!t) throw notFound("User not found");
    if (t.id === actorId) throw forbidden("Use Settings → Security for your own account.");
    if (t.orgRole === "owner") throw forbidden("The owner's sign-in can only be changed by the owner.");
    return t;
  }

  /**
   * A one-time link to choose a new password. With email set up it goes straight to the person
   * (the admin never sees it); otherwise the admin gets the link to pass on.
   */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/reset-link", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.manage");
    const t = await target(u.id, req.params.id);
    if (t.status !== "active") throw badRequest("Reactivate this person first.");
    const token = randomToken(18);
    const authCtx = await ctx.auth.$context;
    await authCtx.internalAdapter.createVerificationValue({
      identifier: `reset-password:${token}`,
      value: t.id,
      expiresAt: new Date(Date.now() + RESET_LINK_MINUTES * 60_000),
    });
    const link = `${cfg.appUrl}/reset-password?token=${encodeURIComponent(token)}`;
    const { productName } = await ctx.mail.brand();
    const emailed = await ctx.mail
      .send({
        to: t.email,
        subject: `Reset your ${productName} password`,
        lines: [`Hi ${t.name.split(" ")[0]},`, `${u.name} sent you a link to choose a new password for ${t.email}.`],
        button: { label: "Choose a new password", url: link },
        note: `The link works once and expires in ${RESET_LINK_MINUTES} minutes.`,
      })
      .catch((e: Error) => {
        throw new HttpError(502, `The email couldn't be sent: ${e.message}`, "email_failed");
      });
    await audit(ctx, { actor: u, action: "user.reset_link", targetType: "user", targetId: t.id, meta: { emailed } });
    return emailed ? { emailed: true, email: t.email, expiresInMinutes: RESET_LINK_MINUTES } : { emailed: false, link, expiresInMinutes: RESET_LINK_MINUTES };
  });

  /** For someone who lost their authenticator and backup codes. They can set it up again afterwards. */
  app.post<{ Params: { id: string } }>("/api/admin/users/:id/two-factor/disable", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.users.manage");
    const t = await target(u.id, req.params.id);
    await db.delete(twoFactor).where(eq(twoFactor.userId, t.id));
    await db.update(user).set({ twoFactorEnabled: false }).where(eq(user.id, t.id));
    await audit(ctx, { actor: u, action: "user.two_factor_disabled", targetType: "user", targetId: t.id });
    const { productName } = await ctx.mail.brand();
    await ctx.mail
      .send({
        to: t.email,
        subject: `Two-step sign-in was turned off for your ${productName} account`,
        lines: [`Hi ${t.name.split(" ")[0]},`, `${u.name} turned off two-step sign-in for ${t.email}. You can turn it on again in Settings → Security.`],
        note: "If you didn't ask for this, tell your admin right away.",
      })
      .catch(() => undefined);
    return { ok: true };
  });

  /* ───────────── Admin → Settings → Email ───────────── */

  app.get("/api/admin/email", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const s = await ctx.mail.server();
    if (!s) return { source: null };
    return {
      source: s.source,
      host: s.host,
      port: s.port,
      security: s.security,
      username: s.username,
      hasPassword: !!s.password,
      from: s.from,
    };
  });

  app.put("/api/admin/email", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    if (cfg.smtpUrl) throw badRequest("Email is set by the server (SMTP_URL). Change it there.");
    const body = parse(emailSchema, req.body);
    const org = await getOrg(db);
    if (!org) throw notFound();
    const passwordEnc =
      body.password === undefined ? (org.emailSettings?.passwordEnc ?? null) : body.password ? ctx.box.encrypt(body.password) : null;
    await db
      .update(organization)
      .set({
        emailSettings: { host: body.host, port: body.port, security: body.security, username: body.username || null, passwordEnc, from: body.from },
        updatedAt: new Date(),
      })
      .where(eq(organization.id, org.id));
    await audit(ctx, { actor: u, action: "settings.email_updated", meta: { host: body.host, port: body.port } });
    return { ok: true };
  });

  app.delete("/api/admin/email", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    if (cfg.smtpUrl) throw badRequest("Email is set by the server (SMTP_URL). Change it there.");
    const org = await getOrg(db);
    if (org) await db.update(organization).set({ emailSettings: null }).where(eq(organization.id, org.id));
    await audit(ctx, { actor: u, action: "settings.email_removed" });
    return { ok: true };
  });

  /** Sends a test email to the admin, through the form's settings (before saving) or the saved ones. */
  app.post("/api/admin/email/test", { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } }, async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.auth.manage");
    const body = req.body && typeof req.body === "object" && "host" in req.body ? parse(emailSchema, req.body) : null;
    let server: MailServer | null = null;
    if (body && !cfg.smtpUrl) {
      const saved = (await getOrg(db))?.emailSettings;
      const password = body.password === undefined ? (saved?.passwordEnc ? ctx.box.decrypt(saved.passwordEnc) : null) : body.password || null;
      server = { host: body.host, port: body.port, security: body.security, username: body.username || null, password, from: body.from };
    } else server = await ctx.mail.server();
    if (!server) throw badRequest("Set up a mail server first.");
    const { productName } = await ctx.mail.brand();
    try {
      await ctx.mail.sendWith(server, {
        to: u.email,
        subject: `${productName} test email`,
        lines: [`Hi ${u.name.split(" ")[0]},`, `Email from ${productName} works. Invitations and password resets will be sent from ${server.from}.`],
      });
    } catch (e) {
      throw new HttpError(502, `The mail server said: ${(e as Error).message}`, "email_failed");
    }
    return { ok: true, to: u.email };
  });
}
