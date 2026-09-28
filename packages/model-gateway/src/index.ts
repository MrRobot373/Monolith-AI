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
  apiKey?: string | null;
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

function headers(cfg: ProviderConfig): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
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
  const res = await fetch(`${openAiBase(cfg)}/chat/completions`, {
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
  return [
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

export async function listModels(cfg: ProviderConfig, signal?: AbortSignal): Promise<string[]> {
  if (cfg.type === "mock") return ["aatmiq-demo"];
  if (cfg.type === "ollama" && cfg.baseUrl) {
    const res = await fetch(`${trimSlash(cfg.baseUrl).replace(/\/v1$/, "")}/api/tags`, { signal });
    if (!res.ok) throw new GatewayError(`Ollama returned ${res.status}`);
    const json = (await res.json()) as { models?: { name: string }[] };
    return (json.models ?? []).map((m) => m.name);
  }
  const res = await fetch(`${openAiBase(cfg)}/models`, { headers: headers(cfg), signal });
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
