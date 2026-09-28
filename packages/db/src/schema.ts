/**
 * Aatmiq database schema (P0). See docs/01-foundation.md §12.
 * One organization per install; content is scoped to workspaces.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () =>
  text("id")
    .primaryKey()
    .default(sql`gen_random_uuid()::text`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

export const orgRoleEnum = pgEnum("org_role", ["owner", "admin", "member"]);
export const userStatusEnum = pgEnum("user_status", ["active", "deactivated"]);
export const workspaceRoleEnum = pgEnum("workspace_role", ["admin", "member"]);
export const providerTypeEnum = pgEnum("provider_type", ["ollama", "openai_compatible", "mock"]);
export const budgetPeriodEnum = pgEnum("budget_period", ["day", "week", "month"]);
export const sectionEnum = pgEnum("section", ["chat", "work", "code", "system", "api"]);
export const requestStatusEnum = pgEnum("token_request_status", ["pending", "approved", "denied"]);
export const messageRoleEnum = pgEnum("message_role", ["system", "user", "assistant"]);

/* ───────────── Organization (singleton per install) ───────────── */

export const organization = pgTable("organization", {
  id: id(),
  name: text("name").notNull(),
  productName: text("product_name"),
  accentColor: text("accent_color"),
  loginMessage: text("login_message"),
  budgetPeriod: budgetPeriodEnum("budget_period").notNull().default("month"),
  promptLogging: boolean("prompt_logging").notNull().default(false),
  retentionDays: integer("retention_days"),
  licenseKey: text("license_key"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ───────────── Auth (Better Auth core tables) ───────────── */

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  orgRole: orgRoleEnum("org_role").notNull().default("member"),
  status: userStatusEnum("status").notNull().default("active"),
  jobTitle: text("job_title"),
  customInstructions: text("custom_instructions"),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/* ───────────── Invitations ───────────── */

export const invitation = pgTable("invitation", {
  id: id(),
  email: text("email").notNull(),
  orgRole: orgRoleEnum("org_role").notNull().default("member"),
  workspaces: jsonb("workspaces").$type<{ workspaceId: string; role: "admin" | "member" }[]>().notNull().default([]),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/* ───────────── Workspaces ───────────── */

export const workspace = pgTable("workspace", {
  id: id(),
  name: text("name").notNull(),
  icon: text("icon"),
  description: text("description"),
  tokenLimit: bigint("token_limit", { mode: "number" }),
  defaultModelId: text("default_model_id"),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workspaceMember = pgTable(
  "workspace_member",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: workspaceRoleEnum("role").notNull().default("member"),
    sections: text("sections").array().notNull().default(sql`ARRAY['chat']::text[]`),
    /** Manual per-user override. null = default split of workspace budget (D19). */
    tokenLimit: bigint("token_limit", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.userId] }), index("wm_user_idx").on(t.userId)],
);

/* ───────────── Models ───────────── */

export const modelProvider = pgTable("model_provider", {
  id: id(),
  name: text("name").notNull(),
  type: providerTypeEnum("type").notNull(),
  baseUrl: text("base_url"),
  apiKeyEnc: text("api_key_enc"),
  health: jsonb("health").$type<{ ok: boolean; latencyMs?: number; error?: string; checkedAt: string }>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const model = pgTable(
  "model",
  {
    id: id(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProvider.id, { onDelete: "cascade" }),
    modelKey: text("model_key").notNull(),
    displayName: text("display_name").notNull(),
    contextLength: integer("context_length"),
    sections: text("sections").array().notNull().default(sql`ARRAY['chat','work','code']::text[]`),
    enabled: boolean("enabled").notNull().default(true),
    costInPerM: real("cost_in_per_m"),
    costOutPerM: real("cost_out_per_m"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("model_provider_key_idx").on(t.providerId, t.modelKey)],
);

export const workspaceModel = pgTable(
  "workspace_model",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    modelId: text("model_id")
      .notNull()
      .references(() => model.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.modelId] })],
);

/* ───────────── Usage, budgets, requests ───────────── */

export const usageEvent = pgTable(
  "usage_event",
  {
    id: id(),
    workspaceId: text("workspace_id").references(() => workspace.id, { onDelete: "set null" }),
    userId: text("user_id").references(() => user.id, { onDelete: "set null" }),
    modelId: text("model_id").references(() => model.id, { onDelete: "set null" }),
    section: sectionEnum("section").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    estimated: boolean("estimated").notNull().default(false),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull().default("ok"),
    createdAt: createdAt(),
  },
  (t) => [
    index("usage_ws_time_idx").on(t.workspaceId, t.createdAt),
    index("usage_user_time_idx").on(t.userId, t.createdAt),
  ],
);

export const tokenRequest = pgTable(
  "token_request",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    amount: bigint("amount", { mode: "number" }).notNull(),
    duration: text("duration").$type<"period" | "permanent">().notNull().default("period"),
    reason: text("reason"),
    status: requestStatusEnum("status").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => user.id, { onDelete: "set null" }),
    decidedAmount: bigint("decided_amount", { mode: "number" }),
    note: text("note"),
    /** For "period" approvals: the bonus only counts inside this period. */
    periodStart: timestamp("period_start", { withTimezone: true }),
    createdAt: createdAt(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
  },
  (t) => [index("tr_ws_status_idx").on(t.workspaceId, t.status)],
);

/* ───────────── Chat ───────────── */

export const chat = pgTable(
  "chat",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("New chat"),
    modelId: text("model_id").references(() => model.id, { onDelete: "set null" }),
    pinned: boolean("pinned").notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chat_ws_user_idx").on(t.workspaceId, t.userId, t.updatedAt)],
);

export const message = pgTable(
  "message",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    modelId: text("model_id").references(() => model.id, { onDelete: "set null" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    createdAt: createdAt(),
  },
  (t) => [index("message_chat_idx").on(t.chatId, t.createdAt)],
);

/* ───────────── Notifications & audit ───────────── */

export const notification = pgTable(
  "notification",
  {
    id: id(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("notif_user_idx").on(t.userId, t.createdAt)],
);

export const auditLog = pgTable(
  "audit_log",
  {
    id: id(),
    workspaceId: text("workspace_id"),
    actorId: text("actor_id"),
    actorEmail: text("actor_email"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    meta: jsonb("meta").$type<Record<string, unknown>>(),
    ip: text("ip"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_time_idx").on(t.createdAt)],
);
