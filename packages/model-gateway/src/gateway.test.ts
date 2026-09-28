import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeChat, listModels, openAiBase, streamChat, testProvider } from "./index";

let server: Server;
let base = "";

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "qwen-test" }] }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      res.setHeader("content-type", "text/event-stream");
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
