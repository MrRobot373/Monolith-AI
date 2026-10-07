import { account, auditLog, eq, organization, session, twoFactor as twoFactorTable, user, verification, type DB } from "@aatmiq/db";
import { PRODUCT_NAME } from "@aatmiq/shared";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { twoFactor } from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Config } from "./config";
import type { Mailer } from "./services/mail";

/** Identifier for a one-time SSO login ticket in Better Auth's verification table. */
export const ssoTicketId = (hash: string) => `sso-ticket:${hash}`;

/**
 * After our OIDC callback has verified the identity provider, the browser is sent here with a one-time
 * ticket (2 minutes). Better Auth turns it into a normal session, so every session rule still applies.
 */
function ssoTicketPlugin(hash: (s: string) => string): BetterAuthPlugin {
  return {
    id: "aatmiq-sso-ticket",
    endpoints: {
      ssoTicket: createAuthEndpoint(
        "/sso/ticket",
        { method: "GET", query: z.object({ ticket: z.string().min(10), next: z.string().optional() }) },
        async (ctx) => {
          const fail = (msg: string) => {
            throw ctx.redirect(`/login?sso_error=${encodeURIComponent(msg)}`);
          };
          const v = await ctx.context.internalAdapter.consumeVerificationValue(ssoTicketId(hash(ctx.query.ticket)));
          if (!v || v.expiresAt < new Date()) return fail("That sign-in link expired. Please try again.");
          const found = await ctx.context.internalAdapter.findUserById(v.value);
          if (!found) return fail("Your account wasn't found.");
          const session = await ctx.context.internalAdapter.createSession(found.id);
          if (!session) return fail("Your account is deactivated. Ask your admin for help.");
          await setSessionCookie(ctx, { session, user: found });
          // Only same-site paths: never an absolute URL.
          const next = ctx.query.next && /^\/(?!\/)/.test(ctx.query.next) ? ctx.query.next : "/app";
          throw ctx.redirect(next);
        },
      ),
    },
  };
}

/** Email confirmation links last a day. */
export const VERIFY_LINK_HOURS = 24;
/** Where the confirmation link lands; the app shows a notice from the query string. */
export const VERIFY_CALLBACK = "/app?email_verified=1";

/** Reset links last an hour (Better Auth's default), sent only to active accounts that may use a password. */
export const RESET_LINK_MINUTES = 60;

async function mayUsePassword(db: DB, userId: string): Promise<boolean> {
  const [u] = await db.select({ status: user.status, orgRole: user.orgRole }).from(user).where(eq(user.id, userId));
  if (!u || u.status !== "active") return false;
  // With single sign-on required, only the owner keeps a password (break-glass).
  const [org] = await db.select({ ssoRequired: organization.ssoRequired }).from(organization).limit(1);
  return !org?.ssoRequired || u.orgRole === "owner";
}

export function createAuth(db: DB, cfg: Config, hash: (s: string) => string, mail: Mailer) {
  return betterAuth({
    baseURL: cfg.appUrl,
    basePath: "/api/auth",
    secret: cfg.secret,
    trustedOrigins: [cfg.appUrl],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification, twoFactor: twoFactorTable },
    }),
    appName: PRODUCT_NAME,
    plugins: [
      ssoTicketPlugin(hash),
      // Authenticator-app codes as a second step after the password. Single sign-on skips it:
      // the identity provider applies its own MFA.
      twoFactor({ issuer: PRODUCT_NAME, backupCodeOptions: { amount: 10, length: 10 } }),
    ],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
      resetPasswordTokenExpiresIn: RESET_LINK_MINUTES * 60,
      revokeSessionsOnPasswordReset: true,
      async sendResetPassword({ user: u, url }) {
        if (!(await mayUsePassword(db, u.id))) return;
        const { productName } = await mail.brand();
        await mail.send({
          to: u.email,
          subject: `Reset your ${productName} password`,
          lines: [`Hi ${u.name.split(" ")[0]},`, `Someone asked to reset the password for ${u.email}. If it was you, choose a new password with the button below.`],
          button: { label: "Choose a new password", url },
          note: `The link works once and expires in ${RESET_LINK_MINUTES} minutes. If you didn't ask for this, you can ignore this email; your password stays the same.`,
        });
      },
      async onPasswordReset({ user: u }) {
        await db.insert(auditLog).values({ actorId: u.id, actorEmail: u.email, action: "user.password_reset", targetType: "user", targetId: u.id });
        const { productName } = await mail.brand();
        await mail
          .send({
            to: u.email,
            subject: `Your ${productName} password was changed`,
            lines: [`Hi ${u.name.split(" ")[0]},`, `The password for ${u.email} was just changed, and you were signed out everywhere else.`],
            note: "If this wasn't you, tell your admin right away.",
          })
          .catch(() => undefined);
      },
    },
    emailVerification: {
      expiresIn: VERIFY_LINK_HOURS * 3600,
      sendOnSignUp: false,
      // Never sign in from the link: that would skip the password and two-step sign-in.
      autoSignInAfterVerification: false,
      async sendVerificationEmail({ user: u, url }) {
        const { productName } = await mail.brand();
        await mail.send({
          to: u.email,
          subject: `Confirm your email for ${productName}`,
          lines: [`Hi ${u.name.split(" ")[0]},`, `Confirm that ${u.email} is your address, so password resets and notices reach you.`],
          button: { label: "Confirm my email", url },
          note: `The link expires in ${VERIFY_LINK_HOURS} hours. If you don't have a ${productName} account, you can ignore this email.`,
        });
      },
      async afterEmailVerification(u) {
        await db.insert(auditLog).values({ actorId: u.id, actorEmail: u.email, action: "user.email_verified", targetType: "user", targetId: u.id });
      },
    },
    user: {
      additionalFields: {
        orgRole: { type: "string", input: false, defaultValue: "member" },
        status: { type: "string", input: false, defaultValue: "active" },
      },
    },
    session: {
      expiresIn: 60 * 60 * 24 * 30,
      updateAge: 60 * 60 * 24,
    },
    // Per-IP limits must allow a whole office behind one NAT address. Brute force is
    // limited per account in routes/auth.ts instead.
    rateLimit: {
      enabled: true,
      window: 60,
      max: 600,
      customRules: {
        "/sign-in/email": { window: 60, max: 120 },
        "/request-password-reset": { window: 60, max: 20 },
        "/two-factor/*": { window: 60, max: 60 },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Deactivated users can never start a session.
          before: async (s) => {
            const [u] = await db.select({ status: user.status }).from(user).where(eq(user.id, s.userId));
            if (!u || u.status !== "active") return false;
            return { data: s };
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
