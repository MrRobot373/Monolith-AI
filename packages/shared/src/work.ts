import { z } from "zod";

export const DEFAULT_WORK_SETTINGS = {
  approvals: "risky" as "risky" | "always" | "never",
  searxngUrl: null as string | null,
  allowNetwork: false,
  maxConcurrentPerUser: 2,
  idleMinutes: 15,
};
export type WorkSettingsValue = typeof DEFAULT_WORK_SETTINGS;

export const workSettingsSchema = z.object({
  approvals: z.enum(["risky", "always", "never"]).optional(),
  searxngUrl: z.url().nullable().optional().or(z.literal("").transform(() => null)),
  allowNetwork: z.boolean().optional(),
  maxConcurrentPerUser: z.number().int().min(1).max(20).optional(),
  idleMinutes: z.number().int().min(1).max(240).optional(),
});

export const workTaskCreateSchema = z.object({
  workspaceId: z.string(),
  prompt: z.string().trim().min(1).max(50_000),
  modelId: z.string().optional(),
  projectId: z.string().optional(),
  /** false: create the task without starting it (to add files first), then send the prompt as a message. */
  start: z.boolean().default(true),
});

export const workMessageSchema = z.object({ prompt: z.string().trim().min(1).max(50_000) });

export const skillSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(500),
  body: z.string().trim().min(1).max(50_000),
  scope: z.enum(["org", "personal"]).default("personal"),
  enabled: z.boolean().default(true),
});

/** Five fields: minute hour day-of-month month day-of-week. */
export const cronSchema = z
  .string()
  .trim()
  .refine((s) => s.split(/\s+/).length === 5, "Use five fields: minute hour day month weekday");

export const scheduleSchema = z.object({
  workspaceId: z.string(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  cron: cronSchema,
  timezone: z.string().trim().min(1).max(64).default("UTC"),
  modelId: z.string().nullable().optional(),
  enabled: z.boolean().default(true),
});

export const connectorSchema = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,32}$/, "Use 1–32 lowercase letters, digits, - or _"),
  displayName: z.string().trim().min(1).max(60),
  url: z.url(),
  /** Catalog entry this came from (fills in defaults). */
  catalogId: z.string().trim().max(60).nullable().optional(),
  /** Defaults to "token" when headers are given, else "none". */
  auth: z.enum(["none", "token", "oauth"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** OAuth app from the service (needed where it doesn't support automatic registration). */
  oauthClientId: z.string().trim().max(500).nullable().optional(),
  oauthClientSecret: z.string().trim().max(2000).nullable().optional(),
  oauthScopes: z.string().trim().max(2000).nullable().optional(),
  approveTools: z.string().trim().max(1000).default("*"),
  enabled: z.boolean().default(true),
});

export const connectorUpdateSchema = z.object({
  displayName: z.string().trim().min(1).max(60).optional(),
  url: z.url().optional(),
  auth: z.enum(["none", "token", "oauth"]).optional(),
  /** Replaces all headers; omit to keep them. */
  headers: z.record(z.string(), z.string()).optional(),
  /** Replaces the OAuth app; omit to keep it, null to clear it. */
  oauthClientId: z.string().trim().max(500).nullable().optional(),
  oauthClientSecret: z.string().trim().max(2000).nullable().optional(),
  oauthScopes: z.string().trim().max(2000).nullable().optional(),
  approveTools: z.string().trim().max(1000).optional(),
  enabled: z.boolean().optional(),
});
