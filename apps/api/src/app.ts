import type { DB } from "@aatmiq/db";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { createAuth } from "./auth";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { createSecretBox } from "./crypto";
import { HttpError } from "./errors";
import { adminOrgRoutes } from "./routes/admin-org";
import { adminSystemRoutes } from "./routes/admin-system";
import { authRoutes } from "./routes/auth";
import { chatRoutes } from "./routes/chat";
import { meRoutes } from "./routes/me";
import { requestRoutes } from "./routes/requests";

export async function buildApp(db: DB, cfg: Config, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const ctx: AppContext = { db, cfg, auth: createAuth(db, cfg), box: createSecretBox(cfg.secret) };

  await app.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute" });

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

  app.get("/api/health", async () => ({ ok: true }));

  await authRoutes(app, ctx);
  await meRoutes(app, ctx);
  await chatRoutes(app, ctx);
  await requestRoutes(app, ctx);
  await adminOrgRoutes(app, ctx);
  await adminSystemRoutes(app, ctx);
  return app;
}
