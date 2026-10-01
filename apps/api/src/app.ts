import type { DB } from "@aatmiq/db";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { createSecretBox } from "./crypto";
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
import { meRoutes } from "./routes/me";
import { projectRoutes } from "./routes/projects";
import { requestRoutes } from "./routes/requests";

export async function buildApp(
  db: DB,
  cfg: Config,
  opts: { logger?: boolean; storage?: Storage; fetch?: typeof fetch } = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const ctx: AppContext = {
    db,
    cfg,
    auth: createAuth(db, cfg),
    box: createSecretBox(cfg.secret),
    storage: opts.storage ?? createLocalStorage(cfg.storageDir),
    license: new LicenseService(db, cfg, opts.fetch),
  };

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

  await authRoutes(app, ctx);
  await meRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await documentRoutes(app, ctx);
  await projectRoutes(app, ctx);
  await requestRoutes(app, ctx);
  await adminOrgRoutes(app, ctx);
  await adminSystemRoutes(app, ctx);
  await licenseRoutes(app, ctx);

  // Housekeeping: temporary chats older than a day are deleted.
  const purge = () => void purgeTemporaryChats(db).catch((e) => app.log.warn(e, "purging temporary chats failed"));
  let timer: NodeJS.Timeout | undefined;
  app.addHook("onReady", async () => {
    ctx.license.start();
    purge();
    timer = setInterval(purge, 60 * 60 * 1000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    ctx.license.stop();
    await stopOcr();
  });
  return app;
}
