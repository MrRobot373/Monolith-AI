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
  /^(please\s+|can you\s+|could you\s+|kindly\s+)?(translate|rephrase|reword|rewrite|paraphrase|correct|proofread|fix (the |my |this )?(grammar|spelling|typos?)|spell-?check|shorten|make (it|this|the|my)( \w+){0,3}? (sound )?(more |less )?(shorter|longer|formal|polite|friendly|casual|clearer|simpler|professional|positive)|convert|define|what does .{1,40} mean|what is the (capital|meaning|full form|abbreviation|plural|opposite|synonym)|who (is|was)|when (is|was|did)|where is|how do (you|i) (say|spell|pronounce)|give me (a |some )?synonyms?)\b/i;
/** "Summarize: <the text>". Without the text it's a question in disguise ("summarize what makes a good…"). */
const SUMMARY_ASK = /^(please\s+|can you\s+)?(summari[sz]e|tl;?dr|sum up)\b[^\n:]{0,40}[:\n]/i;
const SHORT_WRITE = /\b(one[- ](line|sentence)|two[- ]lines?|(a |an )?(short|quick|brief) (note|message|reply|text|line|caption|thank[- ]you|wish)|thank[- ]you (note|message))\b/i;
const SIMPLE_LIST = /^(please\s+)?(list|name|give me|suggest|tell me)\s+(\d+|a few|some|few|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const WRITE_DOC =
  /\b(write|draft|prepare|compose|create|make)\b.{0,40}\b(e-?mail|mail|letter|application|memo|note|notice|announcement|description|post|agenda|minutes|report|proposal|summary|speech|invitation|message|faq|policy|sop|checklist|presentation|outline|cover letter|resume|cv)\b/i;
const EXPLAIN = /^(please\s+|can you\s+)?(explain|describe|what (is|are) the differences?|how (does|do|can|should)|what should (i|we)|any tips|give me (some )?(tips|advice|ideas))\b/i;
/** One of these is enough: the request needs careful, multi-step work. */
const HARD_STRONG: [RegExp, string][] = [
  [/\bdesign (a|an|the|our|my)\b.{0,60}\b(system|schema|database|architecture|network|pipeline|api|data model|workflow)\b/i, "a system to design"],
  [/\b(plan|roadmap|strategy)\b.{0,80}\b(migrat\w*|rollout|roll out|launch|expansion|implementation|transition|restructur\w*)\b|\bmigrat(e|ion)\b.{0,60}\b(to|from|with)\b.{0,40}\b(downtime|staff|users|laptops|servers|cloud)\b/i, "a plan with many moving parts"],
  [/\b(analy[sz]e|investigate|figure out|work out|find out)\b.{0,20}\b(why|how come|causes?|what caused)\b|\broot cause\b|\blikely causes\b/i, "finding the causes of a problem"],
  [/\b(law|laws|legal(ly)?|statut\w+|liabilit\w+|penalt(y|ies)|indemn\w+|compliance|jurisdiction|notice period)\b/i, "a question with legal consequences"],
];
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
  /\bcontract\b|\bclauses?\b|\bregulat(ion|ory)\b/i,
  /\bfinancial model\b|\bforecast(ing)?\b|\bvaluation\b|\bcash ?flow\b|\bbudget plan\b/i,
];
const HARD_MATH = /\\(frac|int|sum|sqrt|lim)\b|[∫∑√∂]|\b(integral|derivative|differentiate|integrate|eigen\w*|matri(x|ces)|probability|statistically|regression|differential equation)\b/i;
const ARITHMETIC = /\d\s*[-+*/×÷^%]\s*\d|\b(calculate|compute|how much is|percentage of)\b/i;
const CODE_BLOCK = /```|^\s*(def |class |function |import |from \S+ import|const |let |var |public |private |#include|SELECT |INSERT |UPDATE |CREATE TABLE|<\?php|package |fn |func )/im;
const STACK_TRACE = /Traceback \(most recent call last\)|^\s+at [\w.$<>]+ ?\(.*:\d+(:\d+)?\)|\b\w+(Error|Exception): /m;
const CODE_HARD = /\b(debug(ging)?|fix(es|ed)?|bugs?|errors?|crash(es|ed|ing)?|fails?|failed|failing|broken|optimi[sz](e|ing|ation)|refactor(ing)?|performance|slow|memory leak|race condition|architecture|review)\b/i;
/** Asking for code (no code given). */
const CODE_ASK = /\b(write|implement|build|code|create|generate)\b.{0,40}\b(function|program|script|class|algorithm|query|module|service|regex|api|macro|formula)\b/i;
const CODE_DEPTH = /\b(algorithm|complexity|how fast|efficient(ly)?|optimal|shortest path|graph|tree|dynamic programming|recursi\w+|concurren\w+|thread\w*|distributed|scal(e|able|ing)|secure|security)\b/i;

const RANK: Record<Difficulty, number> = { easy: 0, medium: 1, hard: 2 };
const atLeast = (a: Difficulty, b: Difficulty): Difficulty => (RANK[a] >= RANK[b] ? a : b);

/** Difficulty from the request alone; null when the rules can't tell. */
export function judgeByRules(input: RuleInput): { difficulty: Difficulty | null; reason: string } {
  const t = input.text.trim();
  const words = t.split(/\s+/).filter(Boolean).length;
  if (SOCIAL.test(t)) return { difficulty: "easy", reason: "a greeting or a thank-you" };

  let found: { difficulty: Difficulty | null; reason: string };
  const code = CODE_BLOCK.test(t) || STACK_TRACE.test(t);
  const strong = HARD_STRONG.find(([r]) => r.test(t));
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
  } else if (strong && words >= 6) {
    found = { difficulty: "hard", reason: strong[1] };
  } else if (CODE_ASK.test(t)) {
    found = CODE_DEPTH.test(t) || hardHits > 0 ? { difficulty: "hard", reason: "code that needs careful design" } : { difficulty: "medium", reason: "code to write" };
  } else if (hardHits + (questions >= 3 ? 1 : 0) + (listItems >= 4 ? 1 : 0) >= 2) {
    found = { difficulty: "hard", reason: "analysis or planning with several parts" };
  } else if (SUMMARY_ASK.test(t)) {
    found = t.length > 3000 ? { difficulty: "medium", reason: "a summary of a long text" } : { difficulty: "easy", reason: "a short summary" };
  } else if (QUICK_ASK.test(t) && t.length <= 800 && hardHits === 0) {
    found = { difficulty: "easy", reason: "a quick rewrite, translation or fact" };
  } else if (SHORT_WRITE.test(t) && words <= 30 && hardHits === 0) {
    found = { difficulty: "easy", reason: "a short message to write" };
  } else if (SIMPLE_LIST.test(t) && words <= 20 && hardHits === 0) {
    found = { difficulty: "easy", reason: "a simple list" };
  } else if (WRITE_DOC.test(t) && hardHits === 0) {
    found = { difficulty: "medium", reason: "everyday writing" };
  } else if (EXPLAIN.test(t) && hardHits === 0) {
    found = { difficulty: "medium", reason: "an explanation or advice" };
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

/**
 * Measured on Nemotron 3 Nano 4B with office requests: definitions plus examples in the request's
 * own format, the request in quotes. Without the quotes small models carry the request out
 * ("Thank you, Priya…") instead of rating it; without examples they call nearly everything medium.
 */
const JUDGE_SHOTS: [string, Difficulty][] = [
  ["Say thanks to Ravi for the files", "easy"],
  ["Write an email asking the team to submit timesheets by Friday", "medium"],
  ["Work out why customer complaints doubled this month and what to do about it", "hard"],
  ["What is the capital of Japan?", "easy"],
  ["Explain what a balance sheet shows", "medium"],
  ["Choose between two suppliers for our packaging, weighing price, quality and delivery risk", "hard"],
];
const quoteRequest = (t: string) => `Request: "${t.replace(/\s+/g, " ")}"`;
const JUDGE_PROMPT = [
  "You rate how hard a request to an AI assistant is. You never answer or carry out the request.",
  "Reply with one word: easy, medium or hard.",
  "easy = a short reply anyone could write: greetings, one-line messages, simple facts, translations, short lists.",
  "medium = normal office work: emails, letters, explanations, summaries, simple code.",
  "hard = needs expert, careful, multi-step thinking: finding causes, plans with many parts, comparing options to recommend one, system design, legal or financial judgement, complex code or math.",
  "",
  "Examples:",
  ...JUDGE_SHOTS.map(([q, a]) => `${quoteRequest(q)}\nDifficulty: ${a}\n`),
].join("\n");

/** How long the judge may take (AUTO_JUDGE_TIMEOUT_MS): well under a second on a GPU; raise it on CPU-only servers. */
export const JUDGE_TIMEOUT_MS = Number(process.env.AUTO_JUDGE_TIMEOUT_MS) || 4000;

/** Asks the judge model; null if it doesn't answer clearly in time. */
export async function askJudge(provider: ProviderConfig, judge: { modelKey: string; thinkingSwitch: boolean }, text: string, timeoutMs = JUDGE_TIMEOUT_MS) {
  const clipped = text.length > 2000 ? `${text.slice(0, 1500)}\n…\n${text.slice(-500)}` : text;
  try {
    const { text: answer, usage } = await completeChat(
      provider,
      judge.modelKey,
      [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: `${quoteRequest(clipped)}\nDifficulty:` },
      ],
      { temperature: 0, maxTokens: 8, signal: AbortSignal.timeout(timeoutMs), ...(judge.thinkingSwitch && { thinking: false }) },
    );
    // Only the first word counts: a model that answers the request instead ("Thank you…", "Hard work
    // pays…") must not be read as a rating.
    const first = answer.trim().replace(/^difficulty\s*:\s*/i, "").match(/^[a-z]+/i)?.[0]?.toLowerCase();
    const word = first === "easy" || first === "medium" || first === "hard" ? (first as Difficulty) : undefined;
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
