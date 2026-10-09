import { z } from "zod";

/**
 * Auto: the model is picked per message (per task in Work AI) by how hard the request is.
 * Admins put models in tiers; easy requests go to the fast tier, most to the standard one, hard
 * ones to the advanced tier (or the standard model with thinking on, when there's no advanced one).
 */
export const MODEL_TIERS = ["fast", "standard", "advanced"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** The id that stands for Auto wherever a model id is accepted. */
export const AUTO_MODEL_ID = "auto";

export const DEFAULT_ROUTING_SETTINGS = {
  /** Offer Auto in the model menus (when at least two tiers have a model). */
  enabled: true,
  /** Auto is what new chats and tasks start with. */
  default: true,
  /**
   * How unclear requests are judged: "rules" alone (instant), or "model": a short question to the
   * judge model (the fast tier's, or judgeModelId) when the rules can't tell.
   */
  judge: "model" as "rules" | "model",
  judgeModelId: null as string | null,
  /** Hard requests turn thinking on, for models that can switch it. */
  thinkOnHard: true,
};
export type RoutingSettingsValue = typeof DEFAULT_ROUTING_SETTINGS;

export const routingSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  default: z.boolean().optional(),
  judge: z.enum(["rules", "model"]).optional(),
  judgeModelId: z.string().nullable().optional(),
  thinkOnHard: z.boolean().optional(),
});

/** What Auto decided for one answer or task, kept with it and shown to the person. */
export interface Routing {
  difficulty: Difficulty;
  tier: ModelTier;
  /** Thinking was turned on for this answer. */
  thinking: boolean;
  /** "rules": decided from the request itself; "judge": the judge model was asked. */
  by: "rules" | "judge";
  /** A few words on why, for people ("a short greeting", "code to debug"). */
  reason: string;
}

export const routingTrySchema = z.object({
  workspaceId: z.string(),
  text: z.string().min(1).max(20_000),
  section: z.enum(["chat", "work"]).default("chat"),
});
