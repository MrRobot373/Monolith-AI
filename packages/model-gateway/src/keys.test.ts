/**
 * API key rotation: when a provider says a key is out of quota or not accepted, calls move to the
 * next key, the tired key rests, and admins can see which keys rest and why.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { completeChat, fetchWithKeys, keysOf, keyStatus, resetKeyPools, restFor, type ProviderConfig } from "./index";

let server: Server;
let base = "";
const seen: string[] = [];
/** key → how the fake provider answers it */
const behavior: Record<string, "ok" | "weekly" | "rate" | "bad"> = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    const key = (req.headers.authorization ?? "").replace("Bearer ", "");
    seen.push(key);
    const b = behavior[key] ?? "bad";
    if (b === "weekly") {
      res.writeHead(429, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "you've reached your weekly usage limit" }));
    }
    if (b === "rate") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "30" });
      return res.end(JSON.stringify({ error: "too many requests" }));
    }
    if (b === "bad") {
      res.writeHead(401, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: `answered with ${key}` } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  resetKeyPools();
  seen.length = 0;
  for (const k of Object.keys(behavior)) delete behavior[k];
});

const provider = (keys: string[]): ProviderConfig => ({ id: "p1", type: "openai_compatible", baseUrl: base, apiKey: keys.join("\n") });

describe("API key rotation", () => {
  it("reads one key or a list (lines or commas)", () => {
    expect(keysOf({ type: "openai_compatible", apiKey: "a" })).toEqual(["a"]);
    expect(keysOf({ type: "openai_compatible", apiKey: " a \n\nb, c " })).toEqual(["a", "b", "c"]);
    expect(keysOf({ type: "openai_compatible", apiKey: null })).toEqual([]);
  });

  it("moves to the next key when one reaches its usage limit, and stays there", async () => {
    Object.assign(behavior, { k1: "weekly", k2: "ok", k3: "ok" });
    const cfg = provider(["k1", "k2", "k3"]);
    const first = await completeChat(cfg, "m", [{ role: "user", content: "hi" }]);
    expect(first.text).toBe("answered with k2");
    expect(seen).toEqual(["k1", "k2"]);
    const second = await completeChat(cfg, "m", [{ role: "user", content: "again" }]);
    expect(second.text).toBe("answered with k2");
    expect(seen).toEqual(["k1", "k2", "k2"]);
    const st = keyStatus(cfg);
    expect(st).toMatchObject({ total: 3, available: 2 });
    expect(st.resting[0]).toMatchObject({ index: 1 });
    expect(st.resting[0]!.reason).toContain("weekly");
    // A weekly limit rests the key for a day.
    expect(new Date(st.resting[0]!.until).getTime() - Date.now()).toBeGreaterThan(23 * 3_600_000);
  });

  it("skips rejected keys and honours Retry-After", async () => {
    Object.assign(behavior, { bad: "bad", busy: "rate", good: "ok" });
    const cfg = provider(["bad", "busy", "good"]);
    expect((await completeChat(cfg, "m", [{ role: "user", content: "x" }])).text).toBe("answered with good");
    const resting = keyStatus(cfg).resting;
    expect(resting.map((r) => r.index)).toEqual([1, 2]);
    const busyRest = new Date(resting[1]!.until).getTime() - Date.now();
    expect(busyRest).toBeGreaterThan(25_000);
    expect(busyRest).toBeLessThan(35_000);
  });

  it("reports the provider's answer when every key is out", async () => {
    Object.assign(behavior, { a: "weekly", b: "weekly" });
    const cfg = provider(["a", "b"]);
    await expect(completeChat(cfg, "m", [{ role: "user", content: "x" }])).rejects.toThrow(/429/);
    // All resting: the next call tries only the key that wakes first instead of hammering both.
    seen.length = 0;
    await completeChat(cfg, "m", [{ role: "user", content: "x" }]).catch(() => undefined);
    expect(seen).toHaveLength(1);
  });

  it("works without keys and with a single key", async () => {
    behavior.only = "ok";
    const res = await fetchWithKeys(provider(["only"]), `${base}/chat/completions`, { method: "POST", body: "{}" });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(restFor(429, null, "slow down")).toBe(15 * 60_000);
    expect(restFor(401, null, "")).toBe(6 * 3_600_000);
    expect(restFor(429, "120", "")).toBe(120_000);
  });
});
