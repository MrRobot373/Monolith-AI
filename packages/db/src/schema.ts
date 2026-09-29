/**
 * Aatmiq database schema (P0). See docs/01-foundation.md §12.
 * One organization per install; content is scoped to workspaces.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  type AnyPgColumn,
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
export const modelKindEnum = pgEnum("model_kind", ["chat", "embedding"]);
export const documentScopeEnum = pgEnum("document_scope", ["private", "workspace"]);
export const documentStatusEnum = pgEnum("document_status", ["processing", "ready", "failed"]);
export const documentKindEnum = pgEnum("document_kind", ["file", "note", "answer"]);
export const projectVisibilityEnum = pgEnum("project_visibility", ["private", "workspace"]);
export const projectRoleEnum = pgEnum("project_role", ["chat", "edit"]);
/** How far a source can be trusted: the model is told, and answers say so. */
export const sourceLabelEnum = pgEnum("source_label", ["confirmed", "assumption", "tbd"]);

/** pgvector column without fixed dimensions (models differ: 384, 768, 1024…). */
const vector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: (v) => `[${v.join(",")}]`,
  fromDriver: (v) => (typeof v === "string" ? JSON.parse(v) : v),
});
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

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
  /** Model used to embed documents for meaning-based search; null = keyword search only. */
  embeddingModelId: text("embedding_model_id"),
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
    kind: modelKindEnum("kind").notNull().default("chat"),
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
    /** Chats inside a project inherit its instructions, sources and project-only memory. */
    projectId: text("project_id").references((): AnyPgColumn => project.id, { onDelete: "cascade" }),
    /** Visible (read-only) to other project members when true. Private to its owner otherwise. */
    sharedToProject: boolean("shared_to_project").notNull().default(false),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** Temporary chats never appear in lists, search or memory, and are deleted after a day. */
    temporary: boolean("temporary").notNull().default(false),
    /** Last message of the branch being shown. Editing a message starts a new branch. */
    leafMessageId: text("leaf_message_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("chat_ws_user_idx").on(t.workspaceId, t.userId, t.updatedAt),
    index("chat_project_idx").on(t.projectId, t.updatedAt),
    index("chat_title_fts_idx").using("gin", sql`to_tsvector('simple', ${t.title})`),
  ],
);

export const message = pgTable(
  "message",
  {
    id: id(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    /** Previous message in this branch (null for the first). Siblings share a parent. */
    parentId: text("parent_id").references((): AnyPgColumn => message.id, { onDelete: "cascade" }),
    role: messageRoleEnum("role").notNull(),
    content: text("content").notNull(),
    modelId: text("model_id").references(() => model.id, { onDelete: "set null" }),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    error: text("error"),
    /** Documents attached with this user message. */
    attachments: jsonb("attachments").$type<{ id: string; name: string }[]>(),
    /** Sources used for this assistant reply, numbered as cited in the text. */
    citations: jsonb("citations").$type<Citation[]>(),
    createdAt: createdAt(),
  },
  (t) => [
    index("message_chat_idx").on(t.chatId, t.createdAt),
    index("message_parent_idx").on(t.parentId),
    index("message_fts_idx").using("gin", sql`to_tsvector('simple', ${t.content})`),
  ],
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

/* ───────────── Documents ───────────── */

export interface Citation {
  n: number;
  /** "document" sources come from files/notes; "chat" sources are earlier chats in the same project. */
  kind?: "document" | "chat";
  documentId: string | null;
  chatId?: string;
  name: string;
  page: number | null;
  snippet: string;
  label?: "confirmed" | "assumption" | "tbd" | null;
}

export const document = pgTable(
  "document",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    kind: documentKindEnum("kind").notNull().default("file"),
    /** Set for sources that belong to one project (deleted with it). Library documents have none. */
    projectId: text("project_id").references((): AnyPgColumn => project.id, { onDelete: "cascade" }),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    storageKey: text("storage_key").notNull(),
    scope: documentScopeEnum("scope").notNull().default("private"),
    status: documentStatusEnum("status").notNull().default("processing"),
    error: text("error"),
    pageCount: integer("page_count"),
    chunkCount: integer("chunk_count"),
    charCount: integer("char_count"),
    embeddingModelId: text("embedding_model_id"),
    label: sourceLabelEnum("label"),
    /** The newer version that replaces this one. Superseded documents are left out of answers. */
    supersededById: text("superseded_by_id").references((): AnyPgColumn => document.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("document_ws_idx").on(t.workspaceId, t.createdAt)],
);

export const documentChunk = pgTable(
  "document_chunk",
  {
    id: id(),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    page: integer("page"),
    content: text("content").notNull(),
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
    embedding: vector("embedding"),
  },
  (t) => [
    index("chunk_doc_idx").on(t.documentId, t.ordinal),
    index("chunk_tsv_idx").using("gin", t.tsv),
  ],
);

export const chatDocument = pgTable(
  "chat_document",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.chatId, t.documentId] })],
);

/* ───────────── Projects ───────────── */

export const project = pgTable(
  "project",
  {
    id: id(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspace.id, { onDelete: "cascade" }),
    ownerId: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    color: text("color").notNull().default("190"),
    description: text("description"),
    /** Rules every chat in the project follows; they win over personal custom instructions. */
    instructions: text("instructions"),
    visibility: projectVisibilityEnum("visibility").notNull().default("private"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("project_ws_idx").on(t.workspaceId)],
);

export const projectMember = pgTable(
  "project_member",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: projectRoleEnum("role").notNull().default("chat"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);

/** Documents available to every chat in a project (project uploads, notes, saved answers, library links). */
export const projectSource = pgTable(
  "project_source",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id, { onDelete: "cascade" }),
    documentId: text("document_id")
      .notNull()
      .references(() => document.id, { onDelete: "cascade" }),
    addedBy: text("added_by").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.documentId] }), index("psource_doc_idx").on(t.documentId)],
);
