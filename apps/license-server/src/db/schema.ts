/**
 * License server data (our cloud). Holds customers and commercial terms only: no customer content
 * ever reaches this database. Check-ins carry counts (seats, tokens), version and health.
 */
import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgEnum, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

export const licenseStatusEnum = pgEnum("license_status", ["active", "revoked"]);

export const adminUser = pgTable("admin_user", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const adminSession = pgTable("admin_session", {
  /** sha256 of the cookie token. */
  id: text("id").primaryKey(),
  adminId: text("admin_id")
    .notNull()
    .references(() => adminUser.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const signingKey = pgTable("signing_key", {
  kid: text("kid").primaryKey(),
  /** PKCS8 PEM, encrypted with SERVER_SECRET. */
  privateKeyEnc: text("private_key_enc").notNull(),
  publicPem: text("public_pem").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const customer = pgTable("customer", {
  id: id(),
  name: text("name").notNull(),
  contactEmail: text("contact_email"),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const license = pgTable(
  "license",
  {
    id: id(),
    customerId: text("customer_id")
      .notNull()
      .references(() => customer.id, { onDelete: "cascade" }),
    tier: text("tier").notNull(),
    seats: integer("seats").notNull(),
    sections: text("sections").array().notNull(),
    features: text("features").array().notNull(),
    modelMode: text("model_mode").notNull().default("self"),
    workspaceLimit: integer("workspace_limit"),
    accent: text("accent"),
    checkInHours: integer("check_in_hours").notNull().default(24),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    status: licenseStatusEnum("status").notNull().default("active"),
    /** The latest signed key. Changing terms re-signs it; deployments pick it up at check-in. */
    token: text("token").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    lastCheckInAt: timestamp("last_check_in_at", { withTimezone: true }),
    lastVersion: text("last_version"),
    activeSeats: integer("active_seats"),
    /** The first deployment that checked in. Another one using the same key is flagged. */
    instanceId: text("instance_id"),
    instanceConflict: boolean("instance_conflict").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("license_customer_idx").on(t.customerId)],
);

export interface UsageCount {
  section: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

export const checkIn = pgTable(
  "check_in",
  {
    id: id(),
    licenseId: text("license_id")
      .notNull()
      .references(() => license.id, { onDelete: "cascade" }),
    instanceId: text("instance_id").notNull(),
    version: text("version"),
    activeSeats: integer("active_seats").notNull(),
    /** Token counts per section since the previous check-in. Counts only. */
    usage: jsonb("usage").$type<UsageCount[]>().notNull().default([]),
    health: jsonb("health").$type<Record<string, unknown>>(),
    createdAt: createdAt(),
  },
  (t) => [index("check_in_license_idx").on(t.licenseId, t.createdAt)],
);

export const setting = pgTable("setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
});

export const adminAudit = pgTable("admin_audit", {
  id: id(),
  adminId: text("admin_id").references(() => adminUser.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  meta: jsonb("meta"),
  createdAt: createdAt(),
});
