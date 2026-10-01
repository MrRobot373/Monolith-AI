import { account, eq, session, user, verification, type DB } from "@aatmiq/db";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Config } from "./config";

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

export function createAuth(db: DB, cfg: Config, hash: (s: string) => string) {
  return betterAuth({
    baseURL: cfg.appUrl,
    basePath: "/api/auth",
    secret: cfg.secret,
    trustedOrigins: [cfg.appUrl],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    plugins: [ssoTicketPlugin(hash)],
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      maxPasswordLength: 128,
      autoSignIn: true,
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
      customRules: { "/sign-in/email": { window: 60, max: 120 } },
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
