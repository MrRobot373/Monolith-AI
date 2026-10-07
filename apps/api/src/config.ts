import type { S3Config } from "./services/storage";

export interface Config {
  appUrl: string;
  databaseUrl: string;
  secret: string;
  allowMockProvider: boolean;
  port: number;
  storageDir: string;
  /** Uploads go to this S3-compatible bucket instead of storageDir (set S3_BUCKET). */
  s3?: S3Config | null;
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
  /**
   * "auto": each task runs as its own Unix user when the API runs as root. "off": same user as the API.
   * "container": each Work AI task also runs in its own Docker container (see workContainer).
   */
  workIsolation?: "auto" | "off" | "container";
  /** Container mode: the image, network and volume task containers use. */
  workContainer?: { image: string; network: string; volume: { name: string; root: string } | null; docker: string } | null;
  /** Port the browser's (and task containers') egress proxy listens on; 0 = any, on 127.0.0.1 only. */
  egressPort?: number;
  /** Aatmiq Code homes (one per person). */
  codeDir?: string;
  /**
   * Serve the IDE from its own address (https://ide.acme.com), apart from APP_URL, so extensions
   * can never act on Aatmiq as the person. Empty: the IDE is under APP_URL/code/ide.
   */
  ideUrl?: string | null;
  /** Minutes an IDE without open windows keeps running. */
  codeIdleMinutes?: number;
  /** Outgoing mail server (smtp://user:pass@host:587 or smtps://…:465). Overrides Admin → Settings → Email. */
  smtpUrl?: string | null;
  /** Sender for SMTP_URL, e.g. "Aatmiq <ai@acme.com>". */
  mailFrom?: string | null;
  /** Redis/Valkey for the job queue; background jobs then run in the worker process. */
  redisUrl?: string | null;
  /** Documents processed at once (per worker, or in the API without Redis). */
  jobConcurrency?: number;
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
    s3: loadS3(env),
    licensePublicKey: env.LICENSE_PUBLIC_KEY || null,
    licenseServerUrl: env.LICENSE_SERVER_URL === undefined ? "https://license.aatmiq.com" : env.LICENSE_SERVER_URL || null,
    version: env.APP_VERSION ?? "0.1.0",
    workDir: env.WORK_DIR ?? ".data/work",
    workControlUrl: env.WORK_CONTROL_URL || null,
    workSandbox: env.WORK_SANDBOX === "off" ? "off" : "on",
    workIsolation: env.WORK_ISOLATION === "off" ? "off" : env.WORK_ISOLATION === "container" ? "container" : "auto",
    workContainer: loadWorkContainer(env),
    egressPort: Number(env.EGRESS_PORT ?? (env.WORK_ISOLATION === "container" ? 3128 : 0)),
    codeDir: env.CODE_DIR ?? ".data/code",
    codeIdleMinutes: Number(env.CODE_IDLE_MINUTES ?? 30),
    ideUrl: loadIdeUrl(env.IDE_URL, env.APP_URL ?? "http://localhost:3000"),
    smtpUrl: env.SMTP_URL || null,
    mailFrom: env.MAIL_FROM || null,
    redisUrl: env.REDIS_URL || null,
    jobConcurrency: Math.max(1, Math.min(16, Number(env.JOB_CONCURRENCY ?? 2) || 2)),
  };
}

/** S3 storage from S3_* variables; null (local disk) without S3_BUCKET. */
export function loadS3(env: NodeJS.ProcessEnv): S3Config | null {
  if (!env.S3_BUCKET) return null;
  const endpoint = env.S3_ENDPOINT || null;
  if (endpoint && !/^https?:\/\//.test(endpoint)) throw new Error("S3_ENDPOINT must start with http:// or https://");
  if (!!env.S3_ACCESS_KEY_ID !== !!env.S3_SECRET_ACCESS_KEY) throw new Error("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (to use the AWS default credentials)");
  const sse = env.S3_SSE || null;
  if (sse !== null && sse !== "AES256" && sse !== "aws:kms") throw new Error('S3_SSE must be "AES256" or "aws:kms"');
  return {
    bucket: env.S3_BUCKET,
    endpoint,
    region: env.S3_REGION || "us-east-1",
    accessKeyId: env.S3_ACCESS_KEY_ID || null,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY || null,
    // Self-hosted services (MinIO and others) want the bucket in the path; AWS prefers the hostname.
    forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "true" : !!endpoint,
    prefix: env.S3_PREFIX || "",
    sse,
    createBucket: env.S3_CREATE_BUCKET === "true",
  };
}

/** IDE_URL as an origin; it must be a different host from APP_URL (otherwise nothing is separated). */
export function loadIdeUrl(value: string | undefined, appUrl: string): string | null {
  if (!value) return null;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error("IDE_URL must be a full address, for example https://ide.acme.com");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("IDE_URL must start with https://");
  if (u.pathname !== "/" || u.search || u.hash) throw new Error("IDE_URL must be just the address, without a path");
  if (u.host === new URL(appUrl).host) throw new Error("IDE_URL must be a different hostname from APP_URL");
  return u.origin;
}

/** Container mode needs an image and a control URL the task network can reach. */
export function loadWorkContainer(env: NodeJS.ProcessEnv) {
  if (env.WORK_ISOLATION !== "container") return null;
  if (!env.WORK_CONTAINER_IMAGE) throw new Error("WORK_ISOLATION=container needs WORK_CONTAINER_IMAGE (the API image, e.g. aatmiq-api)");
  if (!env.WORK_CONTROL_URL) throw new Error("WORK_ISOLATION=container needs WORK_CONTROL_URL, the API as task containers reach it (e.g. http://aatmiq-api:4000/api/internal/work)");
  return {
    image: env.WORK_CONTAINER_IMAGE,
    network: env.WORK_CONTAINER_NETWORK || "aatmiq_tasks",
    volume: env.WORK_CONTAINER_VOLUME ? { name: env.WORK_CONTAINER_VOLUME, root: env.WORK_CONTAINER_VOLUME_ROOT || "/data" } : null,
    docker: env.DOCKER_CLI || "docker",
  };
}
