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
  /** "on": commands can only change the task folder (bwrap/Landlock). "off" where the kernel offers neither. */
  workSandbox?: "on" | "off";
  /** "auto": each task runs as its own Unix user when the API runs as root. "off": same user as the API. */
  workIsolation?: "auto" | "off";
  /** Aatmiq Code homes (one per person). */
  codeDir?: string;
  /** Minutes an IDE without open windows keeps running. */
  codeIdleMinutes?: number;
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
    workSandbox: env.WORK_SANDBOX === "off" ? "off" : "on",
    workIsolation: env.WORK_ISOLATION === "off" ? "off" : "auto",
    codeDir: env.CODE_DIR ?? ".data/code",
    codeIdleMinutes: Number(env.CODE_IDLE_MINUTES ?? 30),
  };
}
