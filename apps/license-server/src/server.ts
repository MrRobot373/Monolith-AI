import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createDb } from "./db";
import { loadSigningKeys } from "./keys";
import { runMigrations } from "./migrate";

const cfg = loadConfig();
await runMigrations(cfg.databaseUrl);
const { db, close } = createDb(cfg.databaseUrl);
const keys = await loadSigningKeys(db, cfg);
const app = await buildApp(db, cfg, keys, { logger: true });
app.log.info({ kid: keys.kid }, "license signing key loaded");

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await app.listen({ port: cfg.port, host: "0.0.0.0" });
