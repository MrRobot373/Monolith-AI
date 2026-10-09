/**
 * Auto: picks the model for a request by how hard it is (docs/02-models.md#auto).
 *
 * 1. Rules read the request itself (instant): greetings and quick rewrites are easy; code to debug,
 *    proofs and multi-part analysis are hard; questions about documents are at least medium.
 * 2. When the rules can't tell, the judge model (the fast tier's, by default) is asked for one
 *    word: easy, medium or hard. It answers in a fraction of a second; if it doesn't, medium.
 * 3. The difficulty picks a tier (easy → fast, medium → standard, hard → advanced), moving to the
 *    next tier when one has no model or its model can't hold the conversation. Hard requests turn
 *    thinking on for models that can switch it.
 */
import { model, modelProvider, organization, usageEvent, eq, and, type DB } from "@aatmiq/db";
import { completeChat, type ProviderConfig } from "@aatmiq/model-gateway";
import {
  AUTO_MODEL_ID,
  DEFAULT_ROUTING_SETTINGS,
  estimateTokens,
  type Difficulty,
  type ModelTier,
  type Routing,
  type RoutingSettingsValue,
  type Section,
} from "@aatmiq/shared";
import type { SecretBox } from "../crypto";
import { badRequest } from "../errors";
import { availableModels, providerConfig, resolveModel, type AvailableModel } from "./models";

export async function routingSettings(db: DB): Promise<RoutingSettingsValue> {
  const [org] = await db.select({ s: organization.routingSettings }).from(organization).limit(1);
  return { ...DEFAULT_ROUTING_SETTINGS, ...(org?.s ?? {}) };
}

/* ───────────── Rules ───────────── */

export interface RuleInput {
  text: string;
  /** Documents or project sources are in play: answers have to read and cite them. */
  hasSources?: boolean;
  /** Difficulty of the previous answer in this conversation (short follow-ups keep it). */
  follows?: Difficulty | null;
}

const SOCIAL =
  /^(hi+|hello+|hey+|namaste|namaskar|good (morning|afternoon|evening|night)|thanks?( you)?|thank you|thx|ty|ok(ay)?|k|cool|great|nice|bye|see you|yes|no|yep|nope|sure|got it|perfect|awesome|done|👍|🙏|😊)( (there|all|everyone|team|guys|sir|madam|ma'am|bro|buddy|so much|very much|a lot))?[\s!.,?🙂😊👍🙏]*$/i;
const QUICK_ASK =
  /^(please\s+|can you\s+|could you\s+|kindly\s+)?(translate|rephrase|reword|paraphrase|correct|proofread|fix (the |my |this )?(grammar|spelling|typos?)|spell-?check|shorten|make (it|this) (shorter|formal|more formal|polite|friendly|casual)|convert|define|what does .{1,40} mean|what is the (capital|meaning|full form|abbreviation|plural|opposite)|who (is|was)|when (is|was|did)|where is|how do (you|i) (say|spell|pronounce)|give me (a )?synonyms?)\b/i;
const SUMMARY_ASK = /^(please\s+|can you\s+)?(summari[sz]e|tl;?dr|sum up)\b/i;
const HARD_WORDS = [
  /\bstep[- ]by[- ]step\b/i,
  /\bin[- ]depth\b|\bthorough(ly)?\b|\bcomprehensive\b/i,
  /\banaly[sz](e|is|ing)\b/i,
  /\bcompar(e|ison)\b|\btrade-?offs?\b|\bpros and cons\b/i,
  /\barchitecture\b|\bsystem design\b|\bdesign (a|an|the) /i,
  /\bstrateg(y|ic)\b|\bbusiness plan\b|\broadmap\b|\bgo-to-market\b/i,
  /\broot cause\b|\bdebug(ging)?\b|\bwhy (does|is) (this|my|it) (fail|crash|break|not work)/i,
  /\boptimi[sz](e|ation)\b|\brefactor(ing)?\b|\balgorithm\b|\b(time|space) complexity\b/i,
  /\bprove\b|\bproof\b|\bderive\b|\btheorem\b/i,
  /\bevaluate\b|\bassess(ment)?\b|\bcritique\b|\breview (this|my|the|our)\b/i,
  /\bresearch\b|\bliterature\b/i,
  /\blegal\b|\bcontract\b|\bclauses?\b|\bliability\b|\bcompliance\b|\bregulat(ion|ory)\b/i,
  /\bfinancial model\b|\bforecast(ing)?\b|\bvaluation\b|\bcash ?flow\b|\bbudget plan\b/i,
];
const HARD_MATH = /\\(frac|int|sum|sqrt|lim)\b|[∫∑√∂]|\b(integral|derivative|differentiate|integrate|eigen\w*|matri(x|ces)|probability|statistically|regression|differential equation)\b/i;
const ARITHMETIC = /\d\s*[-+*/×÷^%]\s*\d|\b(calculate|compute|how much is|percentage of)\b/i;
const CODE_BLOCK = /```|^\s*(def |class |function |import |from \S+ import|const |let |var |public |private |#include|SELECT |INSERT |UPDATE |CREATE TABLE|<\?php|package |fn |func )/im;
const STACK_TRACE = /Traceback \(most recent call last\)|^\s+at [\w.$<>]+ ?\(.*:\d+(:\d+)?\)|\b\w+(Error|Exception): /m;
const CODE_HARD = /\b(debug(ging)?|fix(es|ed)?|bugs?|errors?|crash(es|ed|ing)?|fails?|failed|failing|broken|optimi[sz](e|ing|ation)|refactor(ing)?|performance|slow|memory leak|race condition|architecture|review)\b/i;

const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
const atLeast = (a: Difficulty, b: Difficulty): Difficulty => (RANK[a] >= RANK[b] ? a : b);

/** Difficulty from the request alone; null when the rules can't tell. */
export function judgeByRules(input: RuleInput): { difficulty: Difficulty | null; reason: string } {
  const t = input.text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (SOCIAL.test(t)) return { difficulty: "easy", reason: "a greeting or a thank-you" };

  let found: { difficulty: Difficulty | null; reason: string };
  const code = CODE_BLOCK.test(t) || STACK_TRACE.test(t);
  const hardHits = HARD_WORDS.filter((r) => r.test(t)).length;
  const questions = (t.match(/\?/g) ?? []).length;
  const listItems = (t.match(/^\s*(\d+[.)]|[-*•])\s+\S/gm) ?? []).length;
  const letters = t.match(/\p{L}/gu) ?? [];
  const otherScript = letters.length > 0 && letters.filter((c) => !/[\p{Script=Latin}]/u.test(c)).length / letters.length > 0.3;

  if (code) {
    const lines = t.split("\n").length;
    found =
      STACK_TRACE.test(t) || CODE_HARD.test(t) || lines > 40 || hardHits > 0
        ? { difficulty: "hard", reason: STACK_TRACE.test(t) ? "an error to debug" : "code to debug, improve or design" }
        : { difficulty: "medium", reason: "a question about code" };
  } else if (HARD_MATH.test(t)) {
    found = { difficulty: "hard", reason: "math that needs careful working" };
  } else if (hardHits + (questions >= 3 ? 1 : 0) + (listItems >= 4 ? 1 : 0) >= 2) {
    found = { difficulty: "hard", reason: "analysis or planning with several parts" };
  } else if (SUMMARY_ASK.test(t)) {
    found = t.length > 3000 ? { difficulty: "medium", reason: "a summary of a long text" } : { difficulty: "easy", reason: "a short summary" };
  } else if (QUICK_ASK.test(t) && t.length <= 800 && hardHits === 0) {
    found = { difficulty: "easy", reason: "a quick rewrite, translation or fact" };
  } else if (hardHits === 1 && words >= 8) {
    found = { difficulty: null, reason: "" };
  } else if (ARITHMETIC.test(t)) {
    found = { difficulty: "medium", reason: "a calculation" };
  } else if (words <= 8 && hardHits === 0) {
    found = { difficulty: "easy", reason: "a short, simple question" };
  } else if (t.length > 4000) {
    found = { difficulty: "medium", reason: "a long text to work with" };
  } else {
    found = { difficulty: null, reason: "" };
  }

  // Answers from documents have to read and cite them; small models skip the details.
  if (input.hasSources && found.difficulty !== null && RANK[found.difficulty] < RANK.medium) {
    found = { difficulty: "medium", reason: "an answer from your documents" };
  }
  // Small models are weakest outside English.
  if (otherScript && found.difficulty === "easy") found = { difficulty: "medium", reason: "a request in another language" };
  // "And for Pune?" means as much as the question before it.
  if (input.follows && words < 15 && (found.difficulty === null || RANK[found.difficulty] < RANK[input.follows])) {
    found = { difficulty: input.follows, reason: "a follow-up in this conversation" };
  }
  return found;
}

/* ───────────── The judge ───────────── */

const JUDGE_PROMPT = [
  "You sort requests sent to an AI assistant by how hard they are to answer well.",
  "Reply with exactly one word: easy, medium or hard.",
  "easy: greetings, short factual questions, simple rewrites, translations, spelling fixes, short summaries, simple lists.",
  "medium: explanations, everyday emails and documents, summaries of long text, questions about documents, simple code, everyday reasoning.",
  "hard: multi-step reasoning or math, complex or long code, debugging, system design, detailed analysis, plans and strategies, legal or financial analysis.",
].join("\n");

export const JUDGE_TIMEOUT_MS = 4000;

/** Asks the judge model; null if it doesn't answer clearly in time. */
export async function askJudge(provider: ProviderConfig, judge: { modelKey: string; thinkingSwitch: boolean }, text: string) {
  const clipped = text.length > 2000 ? `${text.slice(0, 1500)}\n…\n${text.slice(-500)}` : text;
  try {
    const { text: answer, usage } = await completeChat(
      provider,
      judge.modelKey,
      [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: `Request:\n<<<\n${clipped}\n>>>\nOne word (easy, medium or hard):` },
      ],
      { temperature: 0, maxTokens: 8, signal: AbortSignal.timeout(JUDGE_TIMEOUT_MS), ...(judge.thinkingSwitch && { thinking: false }) },
    );
    const word = /\b(easy|medium|hard)\b/i.exec(answer)?.[1]?.toLowerCase() as Difficulty | undefined;
    return { difficulty: word ?? null, usage };
  } catch {
    return { difficulty: null, usage: null };
  }
}

/* ───────────── Choosing ───────────── */

const ORDER: Record<Difficulty, ModelTier[]> = {
  easy: ["fast", "standard", "advanced"],
  medium: ["standard", "advanced", "fast"],
  hard: ["advanced", "standard", "fast"],
};

/** Room left for the answer when checking that a conversation fits a model. */
const ANSWER_ROOM = 2048;

/** The tier (and model) for a difficulty: the first tier in order with a model that holds the conversation. */
export function pickModel(models: AvailableModel[], difficulty: Difficulty, promptTokens: number): AvailableModel | null {
  const tiered = models.filter((m) => m.tier);
  if (!tiered.length) return null;
  const fits = (m: AvailableModel) => !m.contextLength || promptTokens + ANSWER_ROOM <= m.contextLength;
  for (const tier of ORDER[difficulty]) {
    const found = tiered.find((m) => m.tier === tier && fits(m));
    if (found) return found;
  }
  // Nothing holds it: the longest context, and the conversation gets trimmed.
  return [...tiered].sort((a, b) => (b.contextLength ?? Infinity) - (a.contextLength ?? Infinity))[0]!;
}

/** Auto is worth offering when the person's models cover at least two tiers. */
export function autoAvailable(models: AvailableModel[], settings: RoutingSettingsValue): boolean {
  return settings.enabled && new Set(models.map((m) => m.tier).filter(Boolean)).size >= 2;
}

/** The Auto entry for model menus, ahead of the real models. */
export function withAuto(models: AvailableModel[], settings: RoutingSettingsValue): AvailableModel[] {
  if (!autoAvailable(models, settings)) return models;
  const tiered = models.filter((m) => m.tier);
  const auto: AvailableModel = {
    id: AUTO_MODEL_ID,
    displayName: "Auto",
    modelKey: AUTO_MODEL_ID,
    providerName: "Aatmiq",
    providerType: "auto",
    contextLength: Math.max(...tiered.map((m) => m.contextLength ?? 0)) || null,
    vision: tiered.some((m) => m.vision),
    isDefault: settings.default,
    groups: [],
    tier: null,
    thinkingSwitch: false,
    tiers: (["fast", "standard", "advanced"] as const).flatMap((tier) =>
      tiered.filter((m) => m.tier === tier).slice(0, 1).map((m) => ({ tier, modelId: m.id, displayName: m.displayName })),
    ),
  };
  return [auto, ...models.map((m) => (settings.default ? { ...m, isDefault: false } : m))];
}

export interface ChooseInput {
  workspaceId: string;
  section: Section;
  userId: string;
  /** A model id, "auto", or nothing (the default, which may be Auto). */
  requested: string | null | undefined;
  /** What the person asked. */
  text: string;
  /** Tokens the model will read besides the request (history, sources). */
  contextTokens?: number;
  hasSources?: boolean;
  follows?: Difficulty | null;
  /** Images to look at: prefer models that read images. */
  needsVision?: boolean;
}

export interface Chosen {
  model: AvailableModel;
  provider: ProviderConfig;
  /** Set when Auto picked the model. */
  routing: Routing | null;
  /** Thinking for this request: set for models that can switch it, undefined otherwise. */
  thinking: boolean | undefined;
}

/** The model for a request: the one asked for, or Auto's pick. */
export async function chooseModel(db: DB, box: SecretBox, input: ChooseInput): Promise<Chosen> {
  const settings = await routingSettings(db);
  const models = await availableModels(db, input.workspaceId, input.section, input.userId);
  const auto =
    input.requested === AUTO_MODEL_ID || (!input.requested && settings.default)
      ? autoAvailable(models, settings)
      : false;
  if (input.requested === AUTO_MODEL_ID && !auto) throw badRequest("Auto isn't available here: ask your admin to put models in at least two tiers.");
  if (!auto) {
    const r = await resolveModel(db, box, input.workspaceId, input.section, input.requested, input.userId);
    return { ...r, routing: null, thinking: r.model.thinkingSwitch ? false : undefined };
  }

  let { difficulty, reason } = judgeByRules({ text: input.text, hasSources: input.hasSources, follows: input.follows });
  let by: Routing["by"] = "rules";
  if (difficulty === null && settings.judge === "model") {
    const judge = await judgeModel(db, box, models, settings);
    if (judge) {
      const answer = await askJudge(judge.provider, judge.model, input.text);
      if (answer.usage) {
        await db.insert(usageEvent).values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          modelId: judge.model.id,
          section: input.section,
          inputTokens: answer.usage.inputTokens,
          outputTokens: answer.usage.outputTokens,
          estimated: answer.usage.estimated,
          status: "ok",
        });
      }
      if (answer.difficulty) {
        difficulty = answer.difficulty;
        by = "judge";
        reason = `judged ${answer.difficulty} by ${judge.model.displayName}`;
      }
    }
  }
  if (difficulty === null) {
    difficulty = "medium";
    reason = "an everyday request";
  }
  // Agents need reliable tool use: Work AI and Code start at the standard tier.
  if (input.section !== "chat") difficulty = atLeast(difficulty, "medium");

  const promptTokens = estimateTokens(input.text) + (input.contextTokens ?? 0);
  let pool = models;
  if (input.needsVision && models.some((m) => m.tier && m.vision)) pool = models.filter((m) => m.vision);
  const picked = pickModel(pool, difficulty, promptTokens)!;
  const thinking = picked.thinkingSwitch ? difficulty === "hard" && settings.thinkOnHard : undefined;
  const routing: Routing = { difficulty, tier: picked.tier as ModelTier, thinking: thinking === true, by, reason };
  return { model: picked, provider: await providerConfig(db, box, picked.id), routing, thinking };
}

/** The judge: the admin's choice, else a fast-tier model (the person's first, else any enabled one). */
async function judgeModel(db: DB, box: SecretBox, models: AvailableModel[], settings: RoutingSettingsValue) {
  let row: { id: string; modelKey: string; displayName: string; thinkingSwitch: boolean } | undefined;
  const cols = { id: model.id, modelKey: model.modelKey, displayName: model.displayName, thinkingSwitch: model.thinkingSwitch };
  if (settings.judgeModelId) {
    [row] = await db.select(cols).from(model).where(and(eq(model.id, settings.judgeModelId), eq(model.enabled, true), eq(model.kind, "chat")));
  }
  if (!row) {
    const mine = models.find((m) => m.tier === "fast");
    if (mine) row = { id: mine.id, modelKey: mine.modelKey, displayName: mine.displayName, thinkingSwitch: mine.thinkingSwitch };
  }
  if (!row) {
    [row] = await db
      .select(cols)
      .from(model)
      .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
      .where(and(eq(model.tier, "fast"), eq(model.enabled, true), eq(model.kind, "chat")))
      .limit(1);
  }
  return row ? { model: row, provider: await providerConfig(db, box, row.id) } : null;
}
