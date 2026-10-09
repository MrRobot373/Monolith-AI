/**
 * Auto: which model answers. The rules on their own, then against a fake model server with a fast,
 * a standard and an advanced model: the judge for unclear requests (and when it's slow or vague),
 * thinking switched on for hard requests only, follow-ups, conversations too long for a small
 * model, usage charged to the model that answered, Work AI tasks, and the admin's settings.
 */
import { createDb, sql, usageEvent, workTask, eq, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import type { AvailableModel } from "./services/models";
import { judgeByRules, pickModel } from "./services/router";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";

describe("rules", () => {
  const level = (text: string, extra: { hasSources?: boolean; follows?: "easy" | "medium" | "hard" } = {}) => judgeByRules({ text, ...extra }).difficulty;

  it("easy: greetings, thanks, quick rewrites and short questions", () => {
    for (const t of ["hi", "hi there", "Thanks a lot!", "thank you so much 🙏", "ok 👍", "Good morning", "Translate 'good morning' into Hindi", "Fix the grammar: me and him goes to office", "What is the capital of Australia?", "Who is the CEO of Infosys?", "summarize: The meeting moved to Friday at 3 pm in room 4."])
      expect(level(t), t).toBe("easy");
  });

  it("everyday writing and explanations are medium; one strong sign is enough for hard", () => {
    expect(level("Write an email to the team about the new expense process starting next month")).toBe("medium");
    expect(level("Draft a leave application for three days for my sister's wedding")).toBe("medium");
    expect(level("Explain the difference between GST and income tax in simple terms")).toBe("medium");
    expect(level("Write a one-line thank you note to Priya for the birthday cake")).toBe("easy");
    expect(level("Make this sentence sound more polite: send me the file now")).toBe("easy");
    expect(level("List five fruits that are rich in vitamin C")).toBe("easy");
    expect(level("Can you analyze why our sales dropped in the north region last quarter?")).toBe("hard");
    expect(level("Design a database schema for a hospital appointment system with doctors, patients, rooms and billing")).toBe("hard");
    expect(level("Plan the migration of 200 Windows laptops to a new domain with minimal downtime for staff")).toBe("hard");
    expect(level("Draft a letter ending our contract with a vendor, considering notice periods and penalties under Indian law")).toBe("hard");
    expect(level("Write a Python function that finds the shortest path in a weighted graph and explain how fast it is")).toBe("hard");
    expect(level("Write a Python script that renames the files in a folder by date")).toBe("medium");
    // Summarizing what you paste is quick; "summarize the key points of…" asks for knowledge.
    expect(level("Summarize the key points of a good customer service call")).not.toBe("easy");
  });

  it("hard: code to debug, math, and analysis with several parts", () => {
    const trace = "Why does this fail?\n```python\ndef total(xs):\n    return sum(x.price for x in xs)\n```\nTraceback (most recent call last):\n  File \"app.py\", line 3\nAttributeError: 'dict' object has no attribute 'price'";
    expect(level(trace)).toBe("hard");
    expect(judgeByRules({ text: trace }).reason).toBe("an error to debug");
    expect(level("Find the derivative of x^3 sin(x) and explain each step")).toBe("hard");
    expect(level("Compare AWS and Azure for our ERP migration: costs, trade-offs and a step-by-step plan")).toBe("hard");
    expect(level("Review this contract clause for liability risks and compliance with Indian law")).toBe("hard");
  });

  it("medium: code questions, calculations, long texts, and anything with documents", () => {
    expect(level("```js\nconst a = [1, 2, 3];\n```\nWhat does this print?")).toBe("medium");
    expect(level("How much is 18% GST on 45,000 rupees?")).toBe("medium");
    expect(level("hello", { hasSources: true })).toBe("easy"); // still just a greeting
    expect(level("What is the leave policy?", { hasSources: true })).toBe("medium");
    expect(level("मुझे छुट्टी के लिए आवेदन लिखना है")).toBe("medium");
  });

  it("unclear requests are left to the judge; short follow-ups keep the conversation's level", () => {
    expect(level("What do you think about the board's view on our numbers this quarter")).toBeNull();
    expect(level("Help me with the weekly update for the operations team")).toBeNull();
    expect(level("And in Python?", { follows: "hard" })).toBe("hard");
    expect(judgeByRules({ text: "and for Pune?", follows: "medium" }).reason).toBe("a follow-up in this conversation");
    expect(level("thanks!", { follows: "hard" })).toBe("easy");
  });

  it("picks the next tier when one is missing or can't hold the conversation", () => {
    const m = (id: string, tier: AvailableModel["tier"], contextLength: number | null): AvailableModel => ({
      id, displayName: id, modelKey: id, providerName: "p", providerType: "openai_compatible", contextLength, vision: false, isDefault: false, groups: [], tier, thinkingSwitch: false,
    });
    const fast = m("fast", "fast", 8192);
    const std = m("std", "standard", 65536);
    const adv = m("adv", "advanced", 131072);
    expect(pickModel([fast, std, adv], "easy", 500)?.id).toBe("fast");
    expect(pickModel([fast, std, adv], "easy", 7000)?.id).toBe("std"); // too long for the fast one
    expect(pickModel([fast, std], "hard", 500)?.id).toBe("std");
    expect(pickModel([fast, adv], "medium", 500)?.id).toBe("adv");
    expect(pickModel([std, adv], "easy", 500)?.id).toBe("std");
    expect(pickModel([fast, std, adv], "hard", 200_000)?.id).toBe("adv"); // nothing holds it: the longest
    expect(pickModel([m("plain", null, 8192)], "easy", 10)).toBeNull();
  });
});

(url ? describe : describe.skip)("Auto against model servers", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let server: Server;
  let base = "";
  let workspaceId = "";
  const owner = { cookie: "" };
  const ids: Record<string, string> = {};
  /** Every chat request the fake server got: model and body. */
  const seen: { model: string; body: Record<string, any>; judge: boolean }[] = [];

  async function call(method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(owner.cookie ? { cookie: owner.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) owner.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body };
  }
  const startOf = (body: string) => JSON.parse(body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
  async function ask(chatId: string, content: string, extra: Record<string, unknown> = {}) {
    const before = seen.length;
    const r = await call("POST", `/api/chats/${chatId}/messages`, { content, ...extra });
    expect(r.status).toBe(200);
    const answered = seen.slice(before).filter((s) => !s.judge);
    return { start: startOf(r.body), body: r.body, sent: answered.at(-1)!, judged: seen.slice(before).some((s) => s.judge) };
  }
  const newChat = async (modelId?: string) => (await call("POST", "/api/chats", { workspaceId, ...(modelId ? { modelId } : {}) })).json.id as string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", async () => {
        if (req.url === "/v1/models") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [] }));
        const body = JSON.parse(raw || "{}");
        const system = body.messages?.[0]?.content ?? "";
        const judge = system.startsWith("You rate how hard");
        seen.push({ model: body.model, body, judge });
        const last = body.messages?.at(-1)?.content ?? "";
        let answer = `${body.model} answers`;
        if (judge) {
          if (last.includes("JUDGE-SLOW")) await new Promise((r) => setTimeout(r, 6000));
          answer = last.includes("JUDGE-HARD") ? "hard" : last.includes("JUDGE-VAGUE") ? "It depends on the details." : last.includes("JUDGE-EASY") ? "Easy." : "medium";
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        if (body.chat_template_kwargs?.enable_thinking) res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "Thinking it over." } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 40, completion_tokens: 5 } })}\n\n`);
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;

    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = {
      appUrl: APP_URL,
      databaseUrl: url!,
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: false,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-route-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-route-work-")),
    };
    app = await buildApp(db, cfg);
    await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    const p = await call("POST", "/api/admin/providers", { name: "Model server", type: "openai_compatible", baseUrl: base });
    const add = async (key: string, tier: string | null, contextLength: number, thinkingSwitch: boolean, sections = ["chat", "work", "code"]) =>
      (ids[key] = (await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: key, displayName: key, contextLength, tier, thinkingSwitch, sections })).json.id);
    await add("nano-4b", "fast", 4096, true, ["chat"]);
    await add("nano-30b", "standard", 65536, true);
    await add("plain-model", null, 32768, false);
    await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: [ids["nano-4b"], ids["nano-30b"], ids["plain-model"]], defaultModelId: ids["nano-30b"] });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  it("offers Auto first, as the default, once two tiers have a model", async () => {
    const models = (await call("GET", `/api/workspaces/${workspaceId}/models?section=chat`)).json as { id: string; isDefault: boolean; tiers?: { tier: string }[] }[];
    expect(models[0]).toMatchObject({ id: "auto", isDefault: true });
    expect(models[0]!.tiers!.map((t) => t.tier)).toEqual(["fast", "standard"]);
    expect(models.filter((m) => m.isDefault)).toHaveLength(1);
    // Work AI has only the standard model in a tier: no Auto there.
    expect((await call("GET", `/api/workspaces/${workspaceId}/models?section=work`)).json.map((m: { id: string }) => m.id)).not.toContain("auto");
  });

  it("answers a greeting with the fast model, without thinking, and remembers why", async () => {
    const chatId = await newChat("auto");
    const { start, sent } = await ask(chatId, "hi there");
    expect(sent.model).toBe("nano-4b");
    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(start.routing).toMatchObject({ difficulty: "easy", tier: "fast", thinking: false, by: "rules", reason: "a greeting or a thank-you" });
    const c = (await call("GET", `/api/chats/${chatId}`)).json;
    expect(c.chat ?? c).toMatchObject({ auto: true });
    const answer = (c.messages as { role: string; routing: unknown; modelId: string }[]).find((m) => m.role === "assistant")!;
    expect(answer).toMatchObject({ modelId: ids["nano-4b"], routing: { tier: "fast" } });
  });

  it("thinks on hard requests with the standard model when there's no advanced one", async () => {
    const chatId = await newChat("auto");
    const { start, sent, body } = await ask(chatId, "Prove that the square root of 2 is irrational, step by step.");
    expect(sent.model).toBe("nano-30b");
    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(start.routing).toMatchObject({ difficulty: "hard", tier: "standard", thinking: true });
    // People see that it's thinking before the answer comes.
    expect(body.indexOf("event: thinking")).toBeGreaterThan(-1);
    expect(body.indexOf("event: thinking")).toBeLessThan(body.indexOf("event: delta"));
    // A short follow-up stays on the same level.
    const next = await ask(chatId, "And for the cube root of 3?");
    expect(next.start.routing).toMatchObject({ difficulty: "hard", reason: "a follow-up in this conversation" });
  });

  it("an advanced model takes the hard requests once there is one", async () => {
    const p = (await call("GET", "/api/admin/providers")).json[0];
    ids["super-120b"] = (await call("POST", "/api/admin/models", { providerId: p.id, modelKey: "super-120b", displayName: "super-120b", contextLength: 131072, tier: "advanced", thinkingSwitch: true })).json.id;
    await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: Object.values(ids), defaultModelId: ids["nano-30b"] });
    const chatId = await newChat("auto");
    const { sent, start } = await ask(chatId, "Our checkout crashes:\n```ts\nawait pay(order)\n```\nTypeError: Cannot read properties of undefined (reading 'total')");
    expect(sent.model).toBe("super-120b");
    expect(start.routing).toMatchObject({ difficulty: "hard", tier: "advanced", thinking: true, reason: "an error to debug" });
  });

  it("asks the judge when the rules can't tell; a slow or vague judge means medium", async () => {
    const chatId = await newChat("auto");
    const hard = await ask(chatId, "JUDGE-HARD What do you think about the board's view on our numbers this quarter");
    expect(hard.judged).toBe(true);
    expect(hard.sent.model).toBe("super-120b");
    expect(hard.start.routing).toMatchObject({ difficulty: "hard", by: "judge", reason: "judged hard by nano-4b" });
    // The judge itself is told not to think, and to say one word.
    const judgeCall = seen.filter((s) => s.judge).at(-1)!;
    expect(judgeCall.model).toBe("nano-4b");
    expect(judgeCall.body).toMatchObject({ temperature: 0, max_tokens: 8, chat_template_kwargs: { enable_thinking: false } });

    const easy = await ask(await newChat("auto"), "JUDGE-EASY Help me with the lunch order for the team today please");
    expect(easy.start.routing).toMatchObject({ difficulty: "easy", by: "judge" });
    const vague = await ask(await newChat("auto"), "JUDGE-VAGUE Help me with the weekly update for the operations team");
    expect(vague.start.routing).toMatchObject({ difficulty: "medium", by: "rules", reason: "an everyday request" });
    expect(vague.sent.model).toBe("nano-30b");
    const started = Date.now();
    const slow = await ask(await newChat("auto"), "JUDGE-SLOW Help me with the weekly update for the finance team");
    expect(Date.now() - started).toBeLessThan(5500);
    expect(slow.start.routing).toMatchObject({ difficulty: "medium" });
    // The judge's tokens are counted, as every model call is.
    const judged = await db.select().from(usageEvent).where(eq(usageEvent.modelId, ids["nano-4b"]!));
    expect(judged.length).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it("rules only: no judge call; with the judge off, unclear means medium", async () => {
    await call("PUT", "/api/admin/routing", { judge: "rules" });
    const r = await ask(await newChat("auto"), "JUDGE-HARD What do you think about the board's view on our numbers this quarter");
    expect(r.judged).toBe(false);
    expect(r.start.routing).toMatchObject({ difficulty: "medium", by: "rules" });
    await call("PUT", "/api/admin/routing", { judge: "model" });
  });

  it("a conversation too long for the fast model goes to a bigger one", async () => {
    const chatId = await newChat("auto");
    await ask(chatId, "Here are my notes: " + "the quarterly planning covers inventory, staffing and logistics. ".repeat(200), { modelId: ids["nano-30b"] });
    const { sent, start } = await ask(chatId, "ok thanks", { modelId: "auto" });
    expect(start.routing).toMatchObject({ difficulty: "easy" });
    expect(sent.model).not.toBe("nano-4b");
  });

  it("a model picked by hand is used as is, with thinking off", async () => {
    const chatId = await newChat(ids["nano-30b"]);
    const { sent, start } = await ask(chatId, "Prove Fermat's little theorem");
    expect(sent.model).toBe("nano-30b");
    expect(start.routing).toBeNull();
    expect(sent.body.chat_template_kwargs).toEqual({ enable_thinking: false });
    // Models without a switch get nothing extra.
    const plain = await ask(await newChat(ids["plain-model"]), "hi");
    expect(plain.sent.body).not.toHaveProperty("chat_template_kwargs");
    expect((await call("GET", `/api/chats/${chatId}`)).json).toMatchObject({ auto: false });
  });

  it("charges the answer to the model that gave it", async () => {
    const chatId = await newChat("auto");
    await ask(chatId, "hello");
    const [last] = await db.select().from(usageEvent).where(eq(usageEvent.section, "chat")).orderBy(sql`${usageEvent.createdAt} desc`).limit(1);
    expect(last!.modelId).toBe(ids["nano-4b"]);
  });

  it("Work AI: Auto picks per task, from the standard tier up, and keeps it", async () => {
    const models = (await call("GET", `/api/workspaces/${workspaceId}/models?section=work`)).json as { id: string }[];
    expect(models[0]!.id).toBe("auto");
    const easy = await call("POST", "/api/work/tasks", { workspaceId, prompt: "hi", modelId: "auto", start: false });
    expect(easy.json).toMatchObject({ modelId: ids["nano-30b"], routing: { difficulty: "medium", tier: "standard", thinking: false } });
    const hard = await call("POST", "/api/work/tasks", { workspaceId, prompt: "Design a system architecture for our warehouse sensors and compare two databases", modelId: "auto", start: false });
    expect(hard.json).toMatchObject({ modelId: ids["super-120b"], routing: { difficulty: "hard", tier: "advanced", thinking: true } });
    const [t] = await db.select().from(workTask).where(eq(workTask.id, hard.json.id));
    expect(t!.routing?.thinking).toBe(true);
  });

  it("settings: Auto can be turned off or made optional; the admin can try a message", async () => {
    const tried = await call("POST", "/api/admin/routing/try", { workspaceId, text: "Thanks!" });
    expect(tried.json).toMatchObject({ model: { id: ids["nano-4b"] }, routing: { difficulty: "easy", tier: "fast" } });

    await call("PUT", "/api/admin/routing", { default: false });
    let models = (await call("GET", `/api/workspaces/${workspaceId}/models?section=chat`)).json as { id: string; isDefault: boolean }[];
    expect(models.find((m) => m.isDefault)?.id).toBe(ids["nano-30b"]);
    expect(models[0]!.id).toBe("auto");
    // A chat without a model of its own now uses the workspace default.
    const { start } = await ask(await newChat(), "hi");
    expect(start).toMatchObject({ model: { id: ids["nano-30b"] }, routing: null });

    const onAuto = await newChat("auto");
    await call("PUT", "/api/admin/routing", { enabled: false });
    models = (await call("GET", `/api/workspaces/${workspaceId}/models?section=chat`)).json;
    expect(models.map((m) => m.id)).not.toContain("auto");
    // Asking for Auto is refused; a chat saved on Auto carries on with the default model.
    expect((await call("POST", `/api/chats/${onAuto}/messages`, { content: "hi", modelId: "auto" })).status).toBe(400);
    expect(startOf((await call("POST", `/api/chats/${onAuto}/messages`, { content: "hi" })).body)).toMatchObject({ model: { id: ids["nano-30b"] }, routing: null });
    expect((await call("PUT", "/api/admin/routing", { judgeModelId: "nope" })).status).toBe(400);
    await call("PUT", "/api/admin/routing", { enabled: true, default: true });
  });
});

/**
 * With a real model on Ollama (opt-in): OLLAMA_TEST_URL=http://localhost:11434
 * OLLAMA_TEST_MODEL=nemotron-3-nano:4b. Checks what Ollama reports for it, thinking off for quick
 * answers and on for hard ones, and a real judgement. On a CPU-only machine also set
 * AUTO_JUDGE_TIMEOUT_MS=60000.
 */
const ollamaUrl = process.env.OLLAMA_TEST_URL;
(url && ollamaUrl ? describe : describe.skip)("Auto with a real model on Ollama", () => {
  const key = process.env.OLLAMA_TEST_MODEL ?? "nemotron-3-nano:4b";
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let workspaceId = "";
  const owner = { cookie: "" };
  const ids: Record<string, string> = {};
  async function call(method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(owner.cookie ? { cookie: owner.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) owner.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body };
  }
  const startOf = (body: string) => JSON.parse(body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
  const answerOf = (body: string) =>
    body
      .split("event: delta\ndata: ")
      .slice(1)
      .map((p) => JSON.parse(p.split("\n")[0]!).text as string)
      .join("");

  beforeAll(async () => {
    ({ db, close } = createDb(url!));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    app = await buildApp(db, {
      appUrl: APP_URL,
      databaseUrl: url!,
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: false,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-ollama-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-ollama-work-")),
    });
    await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    // The same model twice, as the fast and the standard tier (two providers, same server).
    for (const [name, tier] of [["Fast", "fast"], ["Standard", "standard"]] as const) {
      const p = await call("POST", "/api/admin/providers", { name: `Ollama ${name}`, type: "ollama", baseUrl: ollamaUrl });
      ids[tier] = (await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: key, displayName: `${key} (${tier})`, tier })).json.id;
    }
    await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: Object.values(ids), defaultModelId: ids.standard });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("detects the model's thinking switch and the context Ollama serves", async () => {
    const m = ((await call("GET", "/api/admin/models")).json as { id: string; thinkingSwitch: boolean; contextLength: number }[]).find((x) => x.id === ids.fast)!;
    expect(m.thinkingSwitch).toBe(true);
    expect(m.contextLength).toBeGreaterThan(0);
  });

  it("answers a greeting with the fast model and no thinking; a hard request thinks first", async () => {
    const chat = (await call("POST", "/api/chats", { workspaceId, modelId: "auto" })).json.id;
    const quick = await call("POST", `/api/chats/${chat}/messages`, { content: "hi there" });
    expect(startOf(quick.body)).toMatchObject({ model: { id: ids.fast }, routing: { tier: "fast", thinking: false } });
    expect(quick.body).not.toContain("event: thinking");
    expect(answerOf(quick.body).trim().length).toBeGreaterThan(0);

    const hard = await call("POST", `/api/chats/${await (await call("POST", "/api/chats", { workspaceId, modelId: "auto" })).json.id}/messages`, {
      content: "Prove that there are infinitely many prime numbers.",
    });
    expect(startOf(hard.body)).toMatchObject({ model: { id: ids.standard }, routing: { difficulty: "hard", thinking: true } });
    expect(hard.body).toContain("event: thinking");
    expect(answerOf(hard.body).trim().length).toBeGreaterThan(0);
  }, 600_000);

  it("the real judge rates a request the rules leave open", async () => {
    const r = await call("POST", "/api/admin/routing/try", { workspaceId, text: "Our website gets 5,000 visitors a day but only 20 enquiries; what is wrong and what should we fix first" });
    expect(r.json.routing.by).toBe("judge");
    expect(["easy", "medium", "hard"]).toContain(r.json.routing.difficulty);
    console.log(`judge: ${r.json.routing.difficulty} in ${r.json.ms} ms`);
  }, 120_000);
});
