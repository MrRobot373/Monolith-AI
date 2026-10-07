import { organization, type DB } from "@aatmiq/db";
import { PRODUCT_NAME } from "@aatmiq/shared";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { createSecretBox, sha256 } from "./crypto";
import { HttpError } from "./errors";
import { documentRoutes } from "./routes/documents";
import { createLocalStorage, type Storage } from "./services/storage";
import { adminOrgRoutes } from "./routes/admin-org";
import { adminSystemRoutes } from "./routes/admin-system";
import { authRoutes } from "./routes/auth";
import { chatRoutes, purgeTemporaryChats } from "./routes/chat";
import { stopOcr } from "./services/ocr";
import { LicenseService } from "./services/license";
import { licenseRoutes } from "./routes/license";
import { ssoRoutes } from "./routes/sso";
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { requestRoutes } from "./routes/requests";
import { workRoutes } from "./routes/work";
import { workConfigRoutes } from "./routes/work-config";
import { startScheduler } from "./services/schedules";
import { CodeServers } from "./services/code";
import { codeRoutes } from "./routes/code";
import { codeInternalRoutes } from "./routes/code-internal";
import { createCodeProxy } from "./routes/code-proxy";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { workInternalRoutes } from "./routes/work-internal";
import { connectorRoutes } from "./routes/connectors";
import { accountRoutes } from "./routes/account";
import { createConnectors } from "./services/connectors";
import { createMailer } from "./services/mail";
import { WorkRunner } from "./services/work";
import type { HarnessEngine } from "@aatmiq/harness";
import type { AddressInfo } from "node:net";
import { chmod, mkdir } from "node:fs/promises";

export async function buildApp(
  db: DB,
  cfg: Config,
  opts: { logger?: boolean; storage?: Storage; fetch?: typeof fetch; workEngine?: HarnessEngine } = {},
): Promise<FastifyInstance> {
  // The IDE proxy (/code/ide) handles its requests before Fastify, so bodies and WebSocket
  // upgrades pass through untouched.
  let ideProxy: ReturnType<typeof createCodeProxy> | null = null;
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    // Live streams and IDE connections never go idle; close them on shutdown.
    forceCloseConnections: true,
    serverFactory: (handler) =>
      createServer((req: IncomingMessage, res: ServerResponse) => {
        if (ideProxy?.matches(req.url)) void ideProxy.http(req, res);
        else handler(req, res);
      }),
  });
  const box = createSecretBox(cfg.secret);
  const storage = opts.storage ?? createLocalStorage(cfg.storageDir);
  const mail = createMailer({ db, cfg, box, storage });
  const ctx = {
    db,
    cfg,
    auth: createAuth(db, cfg, sha256, mail),
    box,
    mail,
    storage,
    license: new LicenseService(db, cfg, opts.fetch),
  } as AppContext;
  ctx.connectors = createConnectors({
    db,
    box: ctx.box,
    appUrl: cfg.appUrl,
    productName: async () => (await db.select({ p: organization.productName }).from(organization).limit(1))[0]?.p ?? PRODUCT_NAME,
    fetch: opts.fetch,
  });
  // The agent runtime calls back into this server (models, approvals, search).
  ctx.work = new WorkRunner(ctx, {
    engine: opts.workEngine,
    controlUrl: () => {
      if (cfg.workControlUrl) return cfg.workControlUrl.replace(/\/$/, "");
      const a = app.server.address() as AddressInfo | null;
      if (!a || typeof a === "string") throw new Error("The API isn't listening yet, so Work AI can't start.");
      return `http://127.0.0.1:${a.port}/api/internal/work`;
    },
    log: (msg, err) => app.log.warn(err, msg),
  });
  ctx.code = new CodeServers(ctx, {
    controlUrl: () => {
      const a = app.server.address() as AddressInfo | null;
      return a && typeof a !== "string" ? `http://127.0.0.1:${a.port}/api/internal/code` : "";
    },
    idleMinutes: cfg.codeIdleMinutes,
    log: (msg, err) => app.log.warn(err, msg),
  });
  ideProxy = createCodeProxy(ctx);
  ideProxy.attach(app.server);

  // Keyed by session when signed in, so colleagues behind one office IP don't share a bucket.
  await app.register(rateLimit, {
    global: true,
    max: 1200,
    timeWindow: "1 minute",
    keyGenerator: (req) => /better-auth\.session_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? req.ip,
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code, details: err.details });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status < 500) {
      return reply.status(status).send({ error: (err as Error).message, code: "request_error" });
    }
    req.log.error(err);
    return reply.status(500).send({ error: "Something went wrong on the server.", code: "internal" });
  });

  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

  app.get("/api/health", async () => ({ ok: true }));

  // License enforcement for changes. Reading stays possible so nobody loses access to their history.
  //  - license not usable (missing, expired past grace, revoked): only sign-in, setup and entering a key work
  //  - admin changes locked (no check-in for 30 days): admin settings are read-only
  const OPEN = [/^\/api\/auth\//, /^\/api\/setup$/, /^\/api\/public\//, /^\/api\/admin\/license/, /^\/api\/invites\//];
  app.addHook("preHandler", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || OPEN.some((r) => r.test(path))) return;
    const { status } = await ctx.license.info();
    if (!status.canUse) throw new HttpError(402, status.message ?? "The license isn't active.", "license_inactive");
    if (!status.canAdmin && path.startsWith("/api/admin/")) throw new HttpError(402, status.message ?? "Admin changes are paused.", "license_admin_locked");
  });

  await ssoRoutes(app, ctx);
  await authRoutes(app, ctx);
  await meRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await documentRoutes(app, ctx);
  await projectRoutes(app, ctx);
  await requestRoutes(app, ctx);
  await adminOrgRoutes(app, ctx);
  await adminSystemRoutes(app, ctx);
  await licenseRoutes(app, ctx);
  await workRoutes(app, ctx);
  await workInternalRoutes(app, ctx);
  await workConfigRoutes(app, ctx);
  await codeRoutes(app, ctx);
  await codeInternalRoutes(app, ctx);
  await connectorRoutes(app, ctx);
  await accountRoutes(app, ctx);

  // Housekeeping: temporary chats older than a day are deleted.
  const purge = () => void purgeTemporaryChats(db).catch((e) => app.log.warn(e, "purging temporary chats failed"));
  let timer: NodeJS.Timeout | undefined;
  let stopScheduler: (() => void) | undefined;
  app.addHook("onReady", async () => {
    // Document storage is the server's alone; Work AI tasks run as other users (docs/06-work-ai.md).
    if (process.getuid?.() === 0 && cfg.storageDir) {
      await mkdir(cfg.storageDir, { recursive: true }).catch(() => undefined);
      await chmod(cfg.storageDir, 0o700).catch(() => undefined);
    }
    ctx.license.start();
    purge();
    void ctx.work.recover().catch((e) => app.log.warn(e, "recovering Work AI tasks failed"));
    stopScheduler = startScheduler(ctx, (msg, err) => app.log.warn(err, msg));
    timer = setInterval(purge, 60 * 60 * 1000);
    timer.unref();
  });
  app.addHook("preClose", async () => {
    ideProxy?.closeAll();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    stopScheduler?.();
    ctx.license.stop();
    await ctx.work.stopAll();
    await ctx.code.stopAll();
    await stopOcr();
  });
  return app;
}
