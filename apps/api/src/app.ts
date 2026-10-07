import { organization, type DB } from "@aatmiq/db";
import { PRODUCT_NAME } from "@aatmiq/shared";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { createSecretBox, sha256 } from "./crypto";
import { HttpError } from "./errors";
import { documentRoutes } from "./routes/documents";
import { createStorage, type Storage } from "./services/storage";
import { adminOrgRoutes } from "./routes/admin-org";
import { groupRoutes } from "./routes/groups";
import { adminSystemRoutes } from "./routes/admin-system";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
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
import { createInProcessJobs, createRedisJobs, type Jobs } from "./services/jobs";
import { BrowserService, findChromium } from "./services/browser";
import { startEgressProxy, type EgressProxy } from "./services/egress";
import { getWorkSettings, WorkRunner } from "./services/work";
import type { HarnessEngine } from "@aatmiq/harness";
import type { AddressInfo } from "node:net";
import { chmod, mkdir } from "node:fs/promises";

export async function buildApp(
  db: DB,
  cfg: Config,
  opts: { logger?: boolean; storage?: Storage; fetch?: typeof fetch; workEngine?: HarnessEngine; jobs?: (ctx: AppContext) => Jobs } = {},
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
        const to = ideProxy?.route(req) ?? "app";
        if (to === "ide") void ideProxy!.http(req, res);
        else if (to === "none") ideProxy!.refuse(req, res);
        else handler(req, res);
      }),
  });
  const box = createSecretBox(cfg.secret);
  const storage = opts.storage ?? createStorage(cfg);
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
  // The Work AI browser reaches the web only through the egress proxy (started on first use).
  let egress: Promise<EgressProxy> | null = null;
  const upstreamProxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || null;
  ctx.browser = new BrowserService({
    executablePath: findChromium(),
    egress: () =>
      (egress ??= startEgressProxy({
        allowedHosts: () => ctx.browser.allowedHosts,
        upstream: upstreamProxy,
        log: (m) => app.log.info(m),
        // Task containers reach it over their network, with their token; otherwise only this machine's browser does.
        ...(cfg.workIsolation === "container"
          ? { host: "0.0.0.0", port: cfg.egressPort ?? 3128, authorize: (token: string) => ctx.work.proxyAllowed(token) }
          : { port: cfg.egressPort ?? 0 }),
      })),
    runtimeDir: join(cfg.workDir ?? ".data/work", ".browser"),
    log: (msg, err) => app.log.warn(err, msg),
  });
  const jobLog = (msg: string, err?: unknown) => app.log.warn(err, msg);
  ctx.jobs = opts.jobs
    ? opts.jobs(ctx)
    : cfg.redisUrl
      ? createRedisJobs({ db, log: jobLog }, cfg.redisUrl)
      : createInProcessJobs({ db, box, storage, license: ctx.license, log: jobLog }, cfg.jobConcurrency);
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

  // Changes only from Aatmiq's own pages: a browser always sends Origin with cross-site writes, so
  // another site (or the IDE's host, with IDE_URL) can't make them with the person's cookies.
  // Calls without Origin (servers, the agent runtime, scripts with tokens) are unaffected.
  const APP_ORIGIN = new URL(cfg.appUrl).origin;
  app.addHook("onRequest", async (req) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
    const path = req.url.split("?")[0]!;
    if (!path.startsWith("/api/") || path.startsWith("/api/internal/")) return;
    const origin = req.headers.origin;
    if (origin && origin !== APP_ORIGIN) throw new HttpError(403, "Requests from other sites aren't allowed.", "bad_origin");
  });

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
  await groupRoutes(app, ctx);
  await adminSystemRoutes(app, ctx);
  await licenseRoutes(app, ctx);
  await workRoutes(app, ctx);
  await workInternalRoutes(app, ctx);
  await workConfigRoutes(app, ctx);
  await codeRoutes(app, ctx);
  await codeInternalRoutes(app, ctx);
  await connectorRoutes(app, ctx);
  await accountRoutes(app, ctx);

  let stopScheduler: (() => void) | undefined;
  app.addHook("onReady", async () => {
    // Document storage is the server's alone; Work AI tasks run as other users (docs/06-work-ai.md).
    if (process.getuid?.() === 0 && cfg.storageDir && !cfg.s3) {
      await mkdir(cfg.storageDir, { recursive: true }).catch(() => undefined);
      await chmod(cfg.storageDir, 0o700).catch(() => undefined);
    }
    // Document processing and housekeeping (temporary chats, license check-in): see services/jobs.ts.
    await ctx.jobs.start();
    // Container mode: task containers use the egress proxy from their first command.
    if (ctx.work.mode === "container") {
      ctx.browser.allowedHosts = (await getWorkSettings(db)).browserAllowedHosts;
      await ctx.browser.egress();
    }
    void ctx.work.recover().catch((e) => app.log.warn(e, "recovering Work AI tasks failed"));
    stopScheduler = startScheduler(ctx, (msg, err) => app.log.warn(err, msg));
  });
  app.addHook("preClose", async () => {
    ideProxy?.closeAll();
  });
  app.addHook("onClose", async () => {
    stopScheduler?.();
    await ctx.jobs.close();
    await ctx.browser.closeAll();
    if (egress) await (await egress).close();
    await ctx.work.stopAll();
    await ctx.code.stopAll();
    await stopOcr();
  });
  return app;
}
