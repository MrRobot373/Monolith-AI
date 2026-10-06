export interface Config {
  appUrl: string;
  databaseUrl: string;
  secret: string;
  allowMockProvider: boolean;
  port: number;
  storageDir: string;
  /** Aatmiq's license public key. When set, a valid license is required. */
  licensePublicKey?: string | null;
  /** Where check-ins go. Empty turns check-ins off (air-gapped installs). */
  licenseServerUrl?: string | null;
  version?: string;
  /** Where Work AI task folders live. */
  workDir?: string;
  /** How the agent runtime reaches this API (default: this server on 127.0.0.1). */
  workControlUrl?: string | null;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const secret = env.APP_SECRET ?? "";
  if (secret.length < 32) throw new Error("APP_SECRET must be at least 32 characters");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return {
    appUrl: env.APP_URL ?? "http://localhost:3000",
    databaseUrl: env.DATABASE_URL,
    secret,
    allowMockProvider: env.ALLOW_MOCK_PROVIDER === "true",
    port: Number(env.PORT ?? 4000),
    storageDir: env.STORAGE_DIR ?? ".data/files",
    licensePublicKey: env.LICENSE_PUBLIC_KEY || null,
    licenseServerUrl: env.LICENSE_SERVER_URL === undefined ? "https://license.aatmiq.com" : env.LICENSE_SERVER_URL || null,
    version: env.APP_VERSION ?? "0.1.0",
    workDir: env.WORK_DIR ?? ".data/work",
    workControlUrl: env.WORK_CONTROL_URL || null,
  };
}
