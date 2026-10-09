import { z } from "zod";
import { ORG_ROLES, SECTIONS, WORKSPACE_ROLES } from "./permissions";
import { MODEL_TIERS } from "./routing";

export const PROVIDER_TYPES = ["ollama", "openai_compatible", "mock"] as const;
export type ProviderType = (typeof PROVIDER_TYPES)[number];

export const BUDGET_PERIODS = ["day", "week", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Use a 6-digit hex color like #22D3EE");

export const setupSchema = z.object({
  orgName: z.string().trim().min(2).max(80),
  name: z.string().trim().min(1).max(80),
  email: z.email(),
  password: z.string().min(10, "Use at least 10 characters").max(128),
  accentColor: hexColor.optional(),
  licenseKey: z.string().trim().max(4096).optional(),
});

export const inviteSchema = z.object({
  email: z.email(),
  orgRole: z.enum(ORG_ROLES).exclude(["owner"]).default("member"),
  workspaces: z
    .array(z.object({ workspaceId: z.string(), role: z.enum(WORKSPACE_ROLES) }))
    .default([]),
});

export const acceptInviteSchema = z.object({
  name: z.string().trim().min(1).max(80),
  password: z.string().min(10, "Use at least 10 characters").max(128),
});

export const workspaceSchema = z.object({
  name: z.string().trim().min(1).max(60),
  icon: z.string().max(8).optional(),
  description: z.string().max(280).optional(),
});

export const memberSchema = z.object({
  userId: z.string(),
  role: z.enum(WORKSPACE_ROLES).default("member"),
  sections: z.array(z.enum(SECTIONS)).default(["chat"]),
});

export const providerSchema = z.object({
  name: z.string().trim().min(1).max(60),
  type: z.enum(PROVIDER_TYPES),
  baseUrl: z.url().optional(),
  /** One key, or several (one per line): calls move to the next when one hits its limit. */
  apiKey: z.string().max(20_000).optional(),
});

export const modelSchema = z.object({
  providerId: z.string(),
  modelKey: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(80),
  kind: z.enum(["chat", "embedding"]).default("chat"),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  /** Accepts images. Detected from Ollama when not given. */
  vision: z.boolean().optional(),
  sections: z.array(z.enum(SECTIONS)).default(["chat", "work", "code"]),
  enabled: z.boolean().default(true),
  costInPerM: z.number().nonnegative().optional(),
  costOutPerM: z.number().nonnegative().optional(),
  /** Embedding models: text put before search queries and before document passages ({title}). */
  queryPrefix: z.string().max(200).nullable().optional(),
  documentPrefix: z.string().max(200).nullable().optional(),
  /** Where Auto uses it (null: Auto leaves it out). */
  tier: z.enum(MODEL_TIERS).nullable().optional(),
  /** Thinking can be switched per request (vLLM's chat template or Ollama's reasoning effort). */
  thinkingSwitch: z.boolean().optional(),
});

/** Updates must not carry defaults, or a partial update would silently reset other fields. */
export const modelUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(["chat", "embedding"]).optional(),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  vision: z.boolean().optional(),
  sections: z.array(z.enum(SECTIONS)).optional(),
  enabled: z.boolean().optional(),
  costInPerM: z.number().nonnegative().optional(),
  costOutPerM: z.number().nonnegative().optional(),
  queryPrefix: z.string().max(200).nullable().optional(),
  documentPrefix: z.string().max(200).nullable().optional(),
  tier: z.enum(MODEL_TIERS).nullable().optional(),
  thinkingSwitch: z.boolean().optional(),
});

export const workspaceModelsSchema = z.object({
  modelIds: z.array(z.string()),
  defaultModelId: z.string().nullable().optional(),
  embeddingModelId: z.string().nullable().optional(),
});

export const budgetSchema = z.object({
  period: z.enum(BUDGET_PERIODS),
  tokenLimit: z.number().int().nonnegative().nullable(),
});

export const userQuotaSchema = z.object({
  tokenLimit: z.number().int().nonnegative().nullable(),
});

export const tokenRequestSchema = z.object({
  workspaceId: z.string(),
  amount: z.number().int().positive().max(1_000_000_000),
  duration: z.enum(["period", "permanent"]).default("period"),
  reason: z.string().max(500).optional(),
});

export const decideRequestSchema = z.object({
  decision: z.enum(["approved", "denied"]),
  amount: z.number().int().positive().optional(),
  note: z.string().max(500).optional(),
});

export const brandingSchema = z.object({
  productName: z.string().trim().min(1).max(40).optional(),
  accentColor: hexColor.optional(),
  loginMessage: z.string().max(280).optional(),
});

export const orgSettingsSchema = z.object({
  promptLogging: z.boolean().optional(),
  retentionDays: z.number().int().positive().nullable().optional(),
});

export const chatCreateSchema = z.object({
  workspaceId: z.string(),
  modelId: z.string().optional(),
  title: z.string().max(120).optional(),
  projectId: z.string().optional(),
  /** Not saved in history, search or memory; deleted after a day. */
  temporary: z.boolean().optional(),
});

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  modelId: z.string().optional(),
  /** Move into a project (id) or back out of one (null). */
  projectId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
  sharedToProject: z.boolean().optional(),
  /** Show another branch: the last message of that branch. */
  leafMessageId: z.string().optional(),
  /** Keep a temporary chat (it can't be made temporary again). */
  temporary: z.literal(false).optional(),
});

export const sendMessageSchema = z
  .object({
    content: z.string().min(1).max(200_000).optional(),
    modelId: z.string().optional(),
    documentIds: z.array(z.string()).max(20).optional(),
    /** Message to continue from. Omitted: the end of the branch being shown. An earlier id (or null) edits and branches. */
    parentId: z.string().nullable().optional(),
    /** Answer this user message again, as a new branch next to the earlier answer. */
    regenerateOf: z.string().optional(),
  })
  .refine((b) => b.content || b.regenerateOf, { message: "Write a message first" });

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  jobTitle: z.string().max(80).optional(),
  customInstructions: z.string().max(4000).optional(),
});

/**
 * Task prefixes for embedding models trained with them, by model name. EmbeddingGemma (1 and 2):
 * "task: search result | query: …" for searches, "title: {title} | text: …" for documents.
 */
export function embeddingPrefixes(modelKey: string): { queryPrefix: string; documentPrefix: string } | null {
  if (/embedding-?gemma/i.test(modelKey)) return { queryPrefix: "task: search result | query: ", documentPrefix: "title: {title} | text: " };
  return null;
}
