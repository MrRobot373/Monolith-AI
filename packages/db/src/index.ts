import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };
export { and, asc, desc, eq, gt, gte, ilike, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";

export type DB = PostgresJsDatabase<typeof schema>;

export function createDb(url = process.env.DATABASE_URL): { db: DB; close: () => Promise<void> } {
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
