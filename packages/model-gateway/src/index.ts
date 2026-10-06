/**
 * Model Gateway provider layer. See docs/01-foundation.md §5.
 * Every model call goes through here so usage can be metered in one place.
 * Access checks and quota enforcement live in the API, which wraps these calls.
 */
import { estimateTokens, type ProviderType } from "@aatmiq/shared";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderConfig {
  type: ProviderType;
  baseUrl?: string | null;
  /** One key, or several (one per line or comma-separated): calls move to the next when one hits a limit. */
  apiKey?: string | null;
  /** Identifies the provider for key rotation state (defaults to its base URL). */
  id?: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** true when the provider did not report usage and we estimated it. */
  estimated: boolean;
}

export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "done"; usage: Usage; finishReason: string | null };

export interface StreamOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs: number;
  models: string[];
  error?: string;
}

export class GatewayError extends Error {
  constructor(
    message: string,
    public readonly status = 502,
  ) {
    super(message);
  }
}

function trimSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

/** OpenAI-compatible base URL (ending in /v1) for a provider. */
export function openAiBase(cfg: ProviderConfig): string {
  if (!cfg.baseUrl) throw new GatewayError("Provider has no base URL", 400);
  const base = trimSlash(cfg.baseUrl);
  if (cfg.type === "ollama") return base.endsWith("/v1") ? base : `${base}/v1`;
  return base;
}

/* ───────────── API keys and rotation ───────────── */

/** The provider's keys, in order. */
export function keysOf(cfg: ProviderConfig): string[] {
  return (cfg.apiKey ?? "")
    .split(/[\n,]+/)
    .map((k) => k.trim())
    .filter(Boolean);
}

interface PoolState {
  current: number;
  /** key → time it may be used again */
  restUntil: Map<string, number>;
  lastError: Map<string, string>;
}
const pools = new Map<string, PoolState>();
const poolOf = (cfg: ProviderConfig) => {
  const id = cfg.id ?? cfg.baseUrl ?? cfg.type;
  let p = pools.get(id);
  if (!p) pools.set(id, (p = { current: 0, restUntil: new Map(), lastError: new Map() }));
  return p;
};

/** Statuses that mean "this key can't be used right now", so another key may work. */
const KEY_PROBLEM = new Set([401, 402, 403, 429]);

/** How long a key rests after a problem. */
export function restFor(status: number, retryAfter: string | null, body: string): number {
  const after = retryAfter ? (/^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now()) : NaN;
  if (Number.isFinite(after) && after > 0) return Math.min(after, 7 * 86_400_000);
  if (status === 429 || status === 402) return /week/i.test(body) ? 86_400_000 : /day|daily/i.test(body) ? 6 * 3_600_000 : 15 * 60_000;
  return 6 * 3_600_000; // 401/403: wrong or revoked key
}

/** Key usage, for admins: how many keys, how many usable now, and why the others rest. */
export function keyStatus(cfg: ProviderConfig) {
  const keys = keysOf(cfg);
  const pool = poolOf(cfg);
  const now = Date.now();
  return {
    total: keys.length,
    available: keys.filter((k) => (pool.restUntil.get(k) ?? 0) <= now).length,
    resting: keys
      .map((k, i) => ({ index: i + 1, until: pool.restUntil.get(k) ?? 0, reason: pool.lastError.get(k) ?? null }))
      .filter((r) => r.until > now)
      .map((r) => ({ index: r.index, until: new Date(r.until).toISOString(), reason: r.reason })),
  };
}

/** Forget rotation state (tests). */
export function resetKeyPools() {
  pools.clear();
}

/**
 * fetch() with the provider's keys: uses the current key and, when the provider answers that this
 * key is out of quota or not accepted (401/402/403/429), rests it and tries the next. Status and
 * headers arrive before the body, so streamed answers never mix keys. With no usable key left the
 * last answer is returned as is.
 */
export async function fetchWithKeys(cfg: ProviderConfig, url: string, init: RequestInit & { headers?: Record<string, string> } = {}): Promise<Response> {
  const keys = keysOf(cfg);
  if (keys.length === 0) return fetch(url, init);
  const pool = poolOf(cfg);
  const now = Date.now();
  // Start from the current key, skipping resting ones; if all rest, try the one that wakes first.
  const order = keys.map((_, i) => (pool.current + i) % keys.length);
  const ready = order.filter((i) => (pool.restUntil.get(keys[i]!) ?? 0) <= now);
  const tryOrder = ready.length ? ready : [...order].sort((a, b) => (pool.restUntil.get(keys[a]!) ?? 0) - (pool.restUntil.get(keys[b]!) ?? 0)).slice(0, 1);
  let last: Response | null = null;
  for (const i of tryOrder) {
    const key = keys[i]!;
    const res = await fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${key}` } });
    if (!KEY_PROBLEM.has(res.status)) {
      pool.current = i;
      pool.restUntil.delete(key);
      return res;
    }
    const body = await res.clone().text().catch(() => "");
    pool.restUntil.set(key, Date.now() + restFor(res.status, res.headers.get("retry-after"), body));
    pool.lastError.set(key, `${res.status} ${body.replace(/\s+/g, " ").slice(0, 120)}`.trim());
    pool.current = (i + 1) % keys.length;
    if (last) await last.body?.cancel().catch(() => undefined);
    last = res;
  }
  return last!;
}

function headers(_cfg: ProviderConfig): Record<string, string> {
  return { "content-type": "application/json" };
}

/** Parse a server-sent-events body into JSON payloads of `data:` lines. */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) {
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") yield data;
      }
    }
  }
  const rest = buf.trim();
  if (rest.startsWith("data:")) {
    const data = rest.slice(5).trim();
    if (data && data !== "[DONE]") yield data;
  }
}

async function* streamOpenAiCompatible(
  cfg: ProviderConfig,
  modelKey: string,
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const res = await fetchWithKeys(cfg, `${openAiBase(cfg)}/chat/completions`, {
    method: "POST",
    headers: headers(cfg),
    signal: opts.signal,
    body: JSON.stringify({
      model: modelKey,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(opts.temperature !== undefined && { temperature: opts.temperature }),
      ...(opts.maxTokens !== undefined && { max_tokens: opts.maxTokens }),
    }),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new GatewayError(`Provider returned ${res.status}: ${text.slice(0, 300)}`, 502);
  }

  let output = "";
  let usage: Usage | null = null;
  let finishReason: string | null = null;
  for await (const data of parseSse(res.body)) {
    let json: {
      choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
    };
    try {
      json = JSON.parse(data);
    } catch {
      continue;
    }
    const choice = json.choices?.[0];
    const text = choice?.delta?.content;
    if (text) {
      output += text;
      yield { type: "delta", text };
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (json.usage && typeof json.usage.prompt_tokens === "number") {
      usage = {
        inputTokens: json.usage.prompt_tokens,
        outputTokens: json.usage.completion_tokens ?? 0,
        estimated: false,
      };
    }
  }
  yield { type: "done", usage: usage ?? estimateUsage(messages, output), finishReason };
}

export function estimateUsage(messages: ChatMessage[], output: string): Usage {
  const input = messages.reduce((n, m) => n + estimateTokens(m.content) + 4, 0);
  return { inputTokens: input, outputTokens: estimateTokens(output), estimated: true };
}

/* ───────────── Mock provider (dev/demo only) ───────────── */

function mockReply(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const proj = /This chat is in the project "([^"]+)"(\. Follow the project's instructions)?/.exec(sys);
  const note = proj ? [`_Project **${proj[1]}**${proj[2] ? ", following its instructions" : ""}._`, ""] : [];
  const sources = [...sys.matchAll(/\[(\d+)\] ([^\n]+)\n([\s\S]*?)(?=\n\n---\n\n|\n<\/sources>)/g)];
  if (sources.length) {
    const lines = sources.slice(0, 3).map((m) => {
      const text = m[3]!.replace(/\s+/g, " ").trim();
      return `- ${text.slice(0, 160)}${text.length > 160 ? "…" : ""} [${m[1]}]`;
    });
    return [
      ...note,
      `Here's what your documents say about _"${last.slice(0, 120)}"_ (demo model, quoting the most relevant passages):`,
      "",
      ...lines,
      "",
      `Connect a real model in **Admin → Models** for full answers.`,
    ].join("\n");
  }
  return [
    ...note,
    `This is a reply from the **Aatmiq demo model**. It runs locally and never leaves this server.`,
    ``,
    `You said: _"${last.slice(0, 160)}${last.length > 160 ? "…" : ""}"_`,
    ``,
    `Connect a real model (Ollama, vLLM or any OpenAI-compatible endpoint) in **Admin → Models** to get real answers. Meanwhile, here is some formatting to check the renderer:`,
    ``,
    `1. Streaming works token by token`,
    `2. Usage is metered against your quota`,
    `3. Code blocks render with syntax styling:`,
    ``,
    "```ts",
    `const answer = await aatmiq.chat({ model: "your-own-model" });`,
    "```",
  ].join("\n");
}

async function* streamMock(
  messages: ChatMessage[],
  opts: StreamOptions,
): AsyncGenerator<StreamEvent> {
  const reply = mockReply(messages);
  const parts = reply.match(/\S+\s*|\s+/g) ?? [reply];
  for (const p of parts) {
    if (opts.signal?.aborted) break;
    await new Promise((r) => setTimeout(r, 12));
    yield { type: "delta", text: p };
  }
  const usage = estimateUsage(messages, reply);
  yield { type: "done", usage: { ...usage, estimated: false }, finishReason: "stop" };
}

/* ───────────── Public API ───────────── */

export function streamChat(
  cfg: ProviderConfig,
  modelKey: string,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): AsyncGenerator<StreamEvent> {
  if (cfg.type === "mock") return streamMock(messages, opts);
  return streamOpenAiCompatible(cfg, modelKey, messages, opts);
}

/** Non-streaming helper built on streamChat (used for titles, tests). */
export async function completeChat(
  cfg: ProviderConfig,
  modelKey: string,
  messages: ChatMessage[],
  opts: StreamOptions = {},
): Promise<{ text: string; usage: Usage }> {
  let text = "";
  for await (const ev of streamChat(cfg, modelKey, messages, opts)) {
    if (ev.type === "delta") text += ev.text;
    else return { text, usage: ev.usage };
  }
  return { text, usage: estimateUsage(messages, text) };
}

/* ───────────── Embeddings ───────────── */

export interface EmbedResult {
  vectors: number[][];
  inputTokens: number;
}

/** Deterministic bag-of-words embedding for the demo provider (no GPU needed). */
export function mockEmbed(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[(h >>> 0) % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** Embed a batch of texts with an OpenAI-compatible /embeddings endpoint (Ollama, vLLM, TEI…). */
export async function embed(
  cfg: ProviderConfig,
  modelKey: string,
  inputs: string[],
  signal?: AbortSignal,
): Promise<EmbedResult> {
  if (inputs.length === 0) return { vectors: [], inputTokens: 0 };
  if (cfg.type === "mock") {
    return { vectors: inputs.map((t) => mockEmbed(t)), inputTokens: inputs.reduce((n, t) => n + estimateTokens(t), 0) };
  }
  const res = await fetchWithKeys(cfg, `${openAiBase(cfg)}/embeddings`, {
    method: "POST",
    headers: headers(cfg),
    signal,
    body: JSON.stringify({ model: modelKey, input: inputs }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new GatewayError(`Embedding provider returned ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { data?: { embedding: number[]; index?: number }[]; usage?: { prompt_tokens?: number } };
  const data = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== inputs.length) throw new GatewayError("Embedding provider returned the wrong number of vectors");
  return {
    vectors: data.map((d) => d.embedding),
    inputTokens: json.usage?.prompt_tokens ?? inputs.reduce((n, t) => n + estimateTokens(t), 0),
  };
}

export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  if (cfg.type === "mock") return ["aatmiq-demo", "aatmiq-embed"];
  if (cfg.type === "ollama" && cfg.baseUrl) {
    const res = await fetchWithKeys(cfg, `${trimSlash(cfg.baseUrl).replace(/\/v1$/, "")}/api/tags`, { signal });
    if (!res.ok) throw new GatewayError(`Ollama returned ${res.status}`);
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }
  const res = await fetchWithKeys(cfg, `${openAiBase(cfg)}/models`, { headers: headers(cfg), signal });
  if (!res.ok) throw new GatewayError(`Provider returned ${res.status}`);
  const json = (await res.json()) as { data?: { id: string }[] };
  return (json.data ?? []).map((m) => m.id);
}

export async function testProvider(cfg: ProviderConfig): Promise<ProviderTestResult> {
  const started = Date.now();
  try {
    const models = await listModels(cfg, AbortSignal.timeout(8000));
    return { ok: true, latencyMs: Date.now() - started, models };
  } catch (e) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      models: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
