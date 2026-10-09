import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeChat, embed, listModels, mockEmbed, modelInfo, openAiBase, streamChat, testProvider, thinkingParams } from "./index";

let server: Server;
let base = "";
/** Request bodies sent to /chat/completions, newest last. */
const bodies: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // Ollama: a model trained for 262k tokens, loaded with 8k per request.
    if (req.url === "/api/show") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ capabilities: ["completion", "tools", "thinking"], model_info: { "nemotron_h.context_length": 262144 } }));
      return;
    }
    if (req.url === "/api/ps") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ models: [{ name: "nemotron-3-nano:4b", model: "nemotron-3-nano:4b", context_length: 8192 }] }));
      return;
    }
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "qwen-test" }] }));
      return;
    }
    if (req.url === "/v1/embeddings") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { prompt_tokens: 7 } }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => bodies.push(JSON.parse(raw)));
      res.setHeader("content-type", "text/event-stream");
      // Thinking first (vLLM's field, then Ollama's), then the answer.
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Let me see. " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: "Greeting." } }] })}\n\n`);
      const chunks = ["Hel", "lo ", "world"];
      for (const c of chunks)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("openai-compatible provider", () => {
  it("streams deltas and reports provider usage", async () => {
    const cfg = { type: "openai_compatible" as const, baseUrl: base };
    const events = [];
    for await (const e of streamChat(cfg, "qwen-test", [{ role: "user", content: "hi" }])) events.push(e);
    const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    expect(text).toBe("Hello world");
    expect(events.at(-1)).toEqual({
      type: "done",
      usage: { inputTokens: 11, outputTokens: 3, estimated: false },
      finishReason: "stop",
    });
  });

  it("keeps the model's thinking apart from its answer", async () => {
    const cfg = { type: "openai_compatible" as const, baseUrl: base };
    const events = [];
    for await (const e of streamChat(cfg, "qwen-test", [{ role: "user", content: "hi" }])) events.push(e);
    expect(events.filter((e) => e.type === "reasoning").map((e) => (e as { text: string }).text)).toEqual(["Let me see. ", "Greeting."]);
    expect((await completeChat(cfg, "qwen-test", [{ role: "user", content: "hi" }])).text).toBe("Hello world");
  });

  it("switches thinking per request: vLLM through the chat template, Ollama by reasoning effort", async () => {
    const vllm = { type: "openai_compatible" as const, baseUrl: base };
    await completeChat(vllm, "qwen-test", [{ role: "user", content: "hi" }], { thinking: false });
    expect(bodies.at(-1)).toMatchObject({ chat_template_kwargs: { enable_thinking: false } });
    await completeChat(vllm, "qwen-test", [{ role: "user", content: "hi" }], { thinking: true });
    expect(bodies.at(-1)).toMatchObject({ chat_template_kwargs: { enable_thinking: true } });
    // Left alone, the server's default applies.
    await completeChat(vllm, "qwen-test", [{ role: "user", content: "hi" }]);
    expect(bodies.at(-1)).not.toHaveProperty("chat_template_kwargs");

    const ollama = { type: "ollama" as const, baseUrl: base.replace(/\/v1$/, "") };
    await completeChat(ollama, "nemotron-3-nano:4b", [{ role: "user", content: "hi" }], { thinking: false });
    expect(bodies.at(-1)).toMatchObject({ reasoning_effort: "none" });
    expect(bodies.at(-1)).not.toHaveProperty("chat_template_kwargs");
    expect(thinkingParams(ollama, true)).toEqual({ reasoning_effort: "high" });
    expect(thinkingParams({ type: "mock" }, true)).toEqual({});
  });

  it("reads an Ollama model's abilities, and the context its server gives each request", async () => {
    const ollama = { type: "ollama" as const, baseUrl: base.replace(/\/v1$/, "") };
    expect(await modelInfo(ollama, "nemotron-3-nano:4b")).toEqual({ vision: false, thinking: true, contextLength: 8192 });
    // Not loaded: what it was trained for.
    expect(await modelInfo(ollama, "qwen3:8b")).toEqual({ vision: false, thinking: true, contextLength: 262144 });
  });

  it("lists models and passes the health test", async () => {
    const cfg = { type: "openai_compatible" as const, baseUrl: base };
    expect(await listModels(cfg)).toEqual(["qwen-test"]);
    expect((await testProvider(cfg)).ok).toBe(true);
  });

  it("reports failures without throwing from testProvider", async () => {
    const r = await testProvider({ type: "openai_compatible", baseUrl: "http://127.0.0.1:1/v1" });
    expect(r.ok).toBe(false);
    expect(r.error).toBeTruthy();
  });
});

describe("helpers", () => {
  it("normalizes ollama base urls", () => {
    expect(openAiBase({ type: "ollama", baseUrl: "http://h:11434/" })).toBe("http://h:11434/v1");
  });
  it("mock provider streams a full reply", async () => {
    const r = await completeChat({ type: "mock" }, "aatmiq-demo", [{ role: "user", content: "ping" }]);
    expect(r.text).toContain("ping");
    expect(r.usage.outputTokens).toBeGreaterThan(0);
  });
});

describe("embeddings", () => {
  it("returns vectors in input order with provider usage", async () => {
    const r = await embed({ type: "openai_compatible", baseUrl: base }, "e5", ["a", "b"]);
    expect(r.vectors).toEqual([[1, 0], [0, 1]]);
    expect(r.inputTokens).toBe(7);
  });
  it("mock embeddings are normalized and similar for overlapping text", () => {
    const a = mockEmbed("annual leave policy for employees");
    const b = mockEmbed("how many days of annual leave do employees get");
    const c = mockEmbed("quarterly revenue forecast");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(Math.hypot(...a)).toBeCloseTo(1);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
  });
});
