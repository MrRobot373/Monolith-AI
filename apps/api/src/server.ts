import { createDb } from "@aatmiq/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { buildApp } from "./app";
import { loadConfig } from "./config";
import { createStorage } from "./services/storage";

const cfg = loadConfig();

// In containers the API applies pending migrations on start (MIGRATIONS_DIR is set in the image).
if (process.env.MIGRATIONS_DIR) {
  const client = postgres(cfg.databaseUrl, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: process.env.MIGRATIONS_DIR });
  await client.end();
}

const { db, close } = createDb(cfg.databaseUrl);
// Fail at start, with a clear message, rather than on the first upload.
// A bucket service started alongside (Compose) may need a few seconds, so try for about half a minute.
const storage = createStorage(cfg);
for (let attempt = 1; ; attempt++) {
  try {
    await storage.check();
    break;
  } catch (e) {
    if (attempt >= 10) throw e;
    console.warn(`${(e as Error).message} Retrying in 3 seconds…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const app = await buildApp(db, cfg, { logger: true, storage });
app.log.info(`Files are stored in ${storage.describe()}`);
// Tasks and IDEs run as their own Unix users here (as root); the image's entrypoint walls off private
// networks for them (deploy/api/firewall.sh). Say so when that didn't happen.
const firewall = process.env.AATMIQ_USER_FIREWALL;
if (firewall && firewall !== "on" && process.getuid?.() === 0 && cfg.workIsolation !== "off")
  app.log.warn("The user firewall is off: Work AI tasks and IDE terminals on this server can reach private networks (the database, model servers, your office network). See docs/10-team-server.md#security.");

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: cfg.port, host: "0.0.0.0" });
