import { account, eq, session, user, verification, type DB } from "@aatmiq/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import type { Config } from "./config";

export function createAuth(db: DB, cfg: Config) {
  return betterAuth({
    baseURL: cfg.appUrl,
    basePath: "/api/auth",
    secret: cfg.secret,
    trustedOrigins: [cfg.appUrl],
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
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
    rateLimit: { enabled: true, window: 60, max: 30 },
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
