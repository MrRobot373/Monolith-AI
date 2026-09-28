import { z } from "zod";
import { ORG_ROLES, SECTIONS, WORKSPACE_ROLES } from "./permissions";

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
  apiKey: z.string().max(512).optional(),
});

export const modelSchema = z.object({
  providerId: z.string(),
  modelKey: z.string().trim().min(1).max(200),
  displayName: z.string().trim().min(1).max(80),
  kind: z.enum(["chat", "embedding"]).default("chat"),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  sections: z.array(z.enum(SECTIONS)).default(["chat", "work", "code"]),
  enabled: z.boolean().default(true),
  costInPerM: z.number().nonnegative().optional(),
  costOutPerM: z.number().nonnegative().optional(),
});

/** Updates must not carry defaults, or a partial update would silently reset other fields. */
export const modelUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  kind: z.enum(["chat", "embedding"]).optional(),
  contextLength: z.number().int().positive().max(10_000_000).optional(),
  sections: z.array(z.enum(SECTIONS)).optional(),
  enabled: z.boolean().optional(),
  costInPerM: z.number().nonnegative().optional(),
  costOutPerM: z.number().nonnegative().optional(),
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
});

export const chatUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  pinned: z.boolean().optional(),
  modelId: z.string().optional(),
});

export const sendMessageSchema = z.object({
  content: z.string().min(1).max(200_000),
  modelId: z.string().optional(),
  documentIds: z.array(z.string()).max(20).optional(),
});

export const profileSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  jobTitle: z.string().max(80).optional(),
  customInstructions: z.string().max(4000).optional(),
});
