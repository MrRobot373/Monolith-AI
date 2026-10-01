import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

export async function runMigrations(url: string, folder = process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../migrations", import.meta.url))) {
  const client = postgres(url, { max: 1, onnotice: () => {} });
  await migrate(drizzle(client), { migrationsFolder: folder });
  await client.end();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  await runMigrations(process.env.DATABASE_URL);
  console.log("migrations applied");
}
