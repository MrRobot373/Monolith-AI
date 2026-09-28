import { createDb } from "@aatmiq/db";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { buildApp } from "./app";
import { loadConfig } from "./config";

const cfg = loadConfig();

// In containers the API applies pending migrations on start (MIGRATIONS_DIR is set in the image).
if (process.env.MIGRATIONS_DIR) {
  const client = postgres(cfg.databaseUrl, { max: 1 });
  await migrate(drizzle(client), { migrationsFolder: process.env.MIGRATIONS_DIR });
  await client.end();
}

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
