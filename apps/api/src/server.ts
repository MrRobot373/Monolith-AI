import { createDb } from "@aatmiq/db";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const cfg = loadConfig();
const { db, close } = createDb(cfg.databaseUrl);
const app = await buildApp(db, cfg, { logger: true });

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
