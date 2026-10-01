import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export type LDB = PostgresJsDatabase<typeof schema>;

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  return { db: drizzle(client, { schema }), close: () => client.end() };
}
