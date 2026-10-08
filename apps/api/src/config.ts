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
  /**
   * Registered at first setup, for the bundled GPU model servers: the main model (SETUP_MODEL_*,
   * the default) and an optional small one for quick jobs (SETUP_SMALL_MODEL_*, Chat only by default).
   */
  setupModels?: SetupModel[];
  /** At first setup: tasks working at once across the organization (SETUP_MAX_RUNNING). */
  setupMaxRunning?: number | null;
  /**
   * Registered at first setup as the workspace's embedding model for document search
   * (SETUP_EMBEDDING_*): EmbeddingGemma 2 on the bundled Ollama, for example.
   */
  setupEmbedding?: { url: string; key: string; displayName: string; type: "ollama" | "openai_compatible"; apiKey: string | null } | null;
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
    setupModels: [loadSetupModel(env, "SETUP_MODEL", ["chat", "work", "code"]), loadSetupModel(env, "SETUP_SMALL_MODEL", ["chat"])].filter((m): m is SetupModel => !!m),
    setupEmbedding: loadSetupEmbedding(env),
    setupMaxRunning: env.SETUP_MAX_RUNNING ? Math.max(1, Math.min(500, Math.round(Number(env.SETUP_MAX_RUNNING)) || 8)) : null,
  };
}

/** SETUP_EMBEDDING_URL, SETUP_EMBEDDING_MODEL, _DISPLAY_NAME, _PROVIDER (ollama | openai_compatible), _API_KEY. */
export function loadSetupEmbedding(env: NodeJS.ProcessEnv): Config["setupEmbedding"] {
  const url = env.SETUP_EMBEDDING_URL;
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) throw new Error("SETUP_EMBEDDING_URL must start with http:// or https://");
  if (!env.SETUP_EMBEDDING_MODEL) throw new Error("SETUP_EMBEDDING_URL needs SETUP_EMBEDDING_MODEL, the model's name on that server");
  const type = env.SETUP_EMBEDDING_PROVIDER || "openai_compatible";
  if (type !== "ollama" && type !== "openai_compatible") throw new Error("SETUP_EMBEDDING_PROVIDER: use ollama or openai_compatible");
  return {
    url: url.replace(/\/+$/, ""),
    key: env.SETUP_EMBEDDING_MODEL,
    displayName: env.SETUP_EMBEDDING_DISPLAY_NAME || env.SETUP_EMBEDDING_MODEL,
    type,
    apiKey: env.SETUP_EMBEDDING_API_KEY || null,
  };
}

export interface SetupModel {
  url: string;
  key: string;
  displayName: string;
  contextLength: number | null;
  apiKey: string | null;
  vision: boolean;
  sections: ("chat" | "work" | "code")[];
}

/** <PREFIX>_URL, <PREFIX> (the model's name there), _DISPLAY_NAME, _CONTEXT, _API_KEY, _VISION, _SECTIONS. */
export function loadSetupModel(env: NodeJS.ProcessEnv, prefix = "SETUP_MODEL", sections: SetupModel["sections"] = ["chat", "work", "code"]): SetupModel | null {
  const url = env[`${prefix}_URL`];
  if (!url) return null;
  if (!/^https?:\/\//.test(url)) throw new Error(`${prefix}_URL must start with http:// or https://`);
  const key = env[prefix];
  if (!key) throw new Error(`${prefix}_URL needs ${prefix}, the model's name on that server`);
  const context = Number(env[`${prefix}_CONTEXT`]);
  const listed = (env[`${prefix}_SECTIONS`] ?? "").split(/[\s,]+/).filter(Boolean);
  if (listed.some((s) => !["chat", "work", "code"].includes(s))) throw new Error(`${prefix}_SECTIONS: use chat, work and/or code`);
  return {
    url: url.replace(/\/+$/, ""),
    key,
    displayName: env[`${prefix}_DISPLAY_NAME`] || key,
    contextLength: Number.isFinite(context) && context > 0 ? Math.round(context) : null,
    apiKey: env[`${prefix}_API_KEY`] || null,
    vision: env[`${prefix}_VISION`] === "true",
    sections: listed.length ? (listed as SetupModel["sections"]) : sections,
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
