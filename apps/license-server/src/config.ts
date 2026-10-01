export interface Config {
  databaseUrl: string;
  /** Encrypts the signing key at rest. 32+ characters. */
  secret: string;
  port: number;
  /** Origin of the Super Admin console (cookies are only accepted from it). */
  consoleUrl: string;
  /** Optional: use this Ed25519 private key (PKCS8 PEM) instead of a generated one. */
  signingKeyPem: string | null;
  bootstrapAdmin: { email: string; password: string; name: string } | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.SERVER_SECRET ?? "";
  if (secret.length < 32) throw new Error("SERVER_SECRET must be at least 32 characters");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl: env.DATABASE_URL,
    secret,
    port: Number(env.PORT ?? 4100),
    consoleUrl: env.CONSOLE_URL ?? "http://localhost:3100",
    signingKeyPem: env.LICENSE_SIGNING_KEY || null,
    bootstrapAdmin:
      env.SUPER_ADMIN_EMAIL && env.SUPER_ADMIN_PASSWORD
        ? { email: env.SUPER_ADMIN_EMAIL.toLowerCase(), password: env.SUPER_ADMIN_PASSWORD, name: env.SUPER_ADMIN_NAME ?? "Super Admin" }
        : null,
  };
}
