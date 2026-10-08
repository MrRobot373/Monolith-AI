/**
 * Document search with an embedding model trained with task prefixes (EmbeddingGemma 2): what the
 * embedding server receives for documents and for searches, re-indexing when the workspace's
 * embedding model changes, and keyword search carrying on when the embedding server is down.
 */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { forEmbedding } from "./services/documents";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";

describe("forEmbedding", () => {
  it("puts the document's name in EmbeddingGemma's title slot", () => {
    expect(forEmbedding("title: {title} | text: ", "Travel policy.pdf", "Economy class.")).toBe("title: Travel policy | text: Economy class.");
    expect(forEmbedding("title: {title} | text: ", "notes", "x")).toBe("title: notes | text: x");
    expect(forEmbedding("title: {title} | text: ", "a|b\nc.md", "x")).toBe("title: a b c | text: x");
    expect(forEmbedding("title: {title} | text: ", ".md", "x")).toBe("title: none | text: x");
    expect(forEmbedding("", "Travel policy.pdf", "Economy class.")).toBe("Economy class.");
  });
});

(url ? describe : describe.skip)("embeddings with task prefixes", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let fake: Server;
  let fakeUrl = "";
  let down = false;
  const seen: { model: string; input: string[] }[] = [];
  let cookie = "";
  let workspaceId = "";

  const call = async (method: "GET" | "POST" | "PUT" | "PATCH", path: string, body?: unknown) => {
    const res = await app.inject({ method, url: path, headers: { origin: APP_URL, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body };
  };
  const upload = async (name: string, content: string) => {
    const boundary = "----aatmiq";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspaceId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="scope"\r\n\r\nprivate\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    );
    const res = await app.inject({ method: "POST", url: "/api/documents", headers: { origin: APP_URL, cookie, "content-type": `multipart/form-data; boundary=${boundary}` }, payload });
    return res.json() as { id: string };
  };
  const doc = async (id: string, until: (d: any) => boolean) => {
    for (let i = 0; i < 100; i++) {
      const d = (await call("GET", `/api/documents/${id}`)).json;
      if (until(d)) return d;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("timed out");
  };
  // A stand-in embedding server: vectors from the words (so related texts are close), whatever the prefix.
  const vec = (t: string) => {
    const v = new Array(32).fill(0);
    for (const w of t.toLowerCase().split(/\W+/)) if (w && !["task", "search", "result", "query", "title", "text", "none"].includes(w)) v[[...w].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 32] += 1;
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      if (req.url === "/v1/embeddings" && !down) {
        const j = JSON.parse(raw);
        const input = [].concat(j.input);
        seen.push({ model: j.model, input });
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: input.map((t: string, index: number) => ({ index, embedding: vec(t) })), usage: { prompt_tokens: 10 } }));
      }
      if (req.url === "/v1/chat/completions") {
        const j = JSON.parse(raw);
        const sys = j.messages.find((m: { role: string }) => m.role === "system")?.content ?? "";
        res.writeHead(200, { "content-type": "text/event-stream" });
        const answer = /42 lakh/.test(sys) ? "The budget is 42 lakh [1]." : "I don't know.";
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(down ? 503 : 404).end();
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;
    ({ db, close } = createDb(url!));
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
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-work-")),
      setupEmbedding: { url: `${fakeUrl}/v1`, key: "embeddinggemma-2:270m", displayName: "EmbeddingGemma 2", type: "openai_compatible", apiKey: null },
    };
    app = await buildApp(db, cfg);
    expect((await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    const p = await call("POST", "/api/admin/providers", { name: "Chat", type: "openai_compatible", baseUrl: `${fakeUrl}/v1` });
    const m = await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "chat-model", displayName: "Chat model" });
    await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await close?.();
    await new Promise<void>((r) => fake?.close(() => r()));
  });

  it("first setup registers EmbeddingGemma 2 with its task prefixes as the workspace's embedding model", async () => {
    const models = (await call("GET", "/api/admin/models")).json as any[];
    const e = models.find((x) => x.kind === "embedding");
    expect(e).toMatchObject({ modelKey: "embeddinggemma-2:270m", queryPrefix: "task: search result | query: ", documentPrefix: "title: {title} | text: " });
    expect((await call("GET", `/api/admin/workspaces/${workspaceId}/models`)).json.embeddingModelId).toBe(e.id);
  });

  it("documents are embedded with their title, questions with the search prefix", async () => {
    // Over 14,000 characters, so answers search it instead of reading it whole.
    const filler = Array.from({ length: 300 }, (_, i) => `Section ${i}: the office plants are watered on Tuesdays and the printer is on floor ${i % 9}.`).join("\n");
    const d = await upload("Launch budget.txt", `The launch budget is 42 lakh. Travel is economy class.\n${filler}`);
    const ready = await doc(d.id, (x) => x.status === "ready");
    expect(ready.chunkCount).toBeGreaterThan(0);
    expect(seen.at(-1)!.model).toBe("embeddinggemma-2:270m");
    expect(seen.at(-1)!.input[0]).toMatch(/^title: Launch budget \| text: The launch budget is 42 lakh/);

    const chat = (await call("POST", "/api/chats", { workspaceId })).json;
    const r = await call("POST", `/api/chats/${chat.id}/messages`, { content: "How much money do we have for the launch?", documentIds: [d.id] });
    expect(r.status).toBe(200);
    const queries = seen.filter((s) => s.input.length === 1 && s.input[0]!.startsWith("task: search result | query: "));
    expect(queries.length).toBeGreaterThan(0);
  });

  it("an admin can change the prefixes; a new embedding model re-indexes the workspace's documents", async () => {
    const providers = (await call("GET", "/api/admin/providers")).json as any[];
    const plain = await call("POST", "/api/admin/models", { providerId: providers[0].id, modelKey: "plain-embedder", displayName: "Plain", kind: "embedding" });
    expect(plain.json).toMatchObject({ queryPrefix: null, documentPrefix: null });
    const edited = await call("PATCH", `/api/admin/models/${plain.json.id}`, { queryPrefix: "query: " });
    expect(edited.json.queryPrefix).toBe("query: ");
    const chatModels = (await call("GET", `/api/admin/workspaces/${workspaceId}/models`)).json;
    const before = seen.length;
    const r = await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { ...chatModels, embeddingModelId: plain.json.id });
    expect(r.json.reindexing).toBe(1);
    const docs = (await call("GET", `/api/documents?workspaceId=${workspaceId}`)).json as any[];
    await doc(docs[0].id, (x) => x.embeddingModelId === plain.json.id);
    const reembedded = seen.slice(before).find((s) => s.model === "plain-embedder");
    expect(reembedded?.input[0]).toMatch(/^The launch budget is 42 lakh/);
    // Setting the same model again doesn't index anything.
    expect((await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { ...chatModels, embeddingModelId: plain.json.id })).json.reindexing).toBe(0);
  });

  it("with the embedding server down, keyword search still finds the document", async () => {
    down = true;
    const docs = (await call("GET", `/api/documents?workspaceId=${workspaceId}`)).json as any[];
    const chat = (await call("POST", "/api/chats", { workspaceId })).json;
    const r = await call("POST", `/api/chats/${chat.id}/messages`, { content: "What is the launch budget?", documentIds: [docs[0].id] });
    down = false;
    expect(r.body).toContain("42 lakh");
  });
});

/**
 * With a real embedding server (EMBEDDING_TEST_URL, an Ollama; EMBEDDING_TEST_MODEL, e.g.
 * embeddinggemma-2:270m, or embeddinggemma on a machine without a GPU): a question that shares no
 * words with the passage still finds it first, by meaning.
 */
const realUrl = process.env.EMBEDDING_TEST_URL;
(url && realUrl ? describe : describe.skip)("a real embedding model finds passages by meaning", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let chatServer: Server;
  let lastSystem = "";
  let cookie = "";
  const call = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown) => {
    const res = await app.inject({ method, url: path, headers: { origin: APP_URL, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, body: res.body };
  };

  beforeAll(async () => {
    chatServer = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      lastSystem = JSON.parse(raw).messages.find((x: { role: string }) => x.role === "system")?.content ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
    await new Promise<void>((r) => chatServer.listen(0, "127.0.0.1", r));
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
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-work-")),
      setupEmbedding: { url: realUrl!, key: process.env.EMBEDDING_TEST_MODEL ?? "embeddinggemma-2:270m", displayName: "EmbeddingGemma", type: "ollama", apiKey: null },
    });
    await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await close?.();
    await new Promise<void>((r) => chatServer?.close(() => r()));
  });

  it("ranks the right passage first for a question in other words", async () => {
    const workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    const p = await call("POST", "/api/admin/providers", { name: "Chat", type: "openai_compatible", baseUrl: `http://127.0.0.1:${(chatServer.address() as { port: number }).port}/v1` });
    const m = await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "chat-model", displayName: "Chat model" });
    await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id });
    const topics = [
      "The cafeteria serves vegetarian thali on Mondays and South Indian breakfast on Fridays.",
      "Visitors must sign in at reception and wear their badge at all times inside the building.",
      "The quarterly town hall is held in the large auditorium on the ground floor.",
      "Parking spaces on level two are reserved for car pools and electric vehicles.",
      "The IT helpdesk answers tickets within four working hours.",
      "Fire drills happen twice a year; the assembly point is the north lawn.",
    ];
    const section = (i: number) => `${topics[i % topics.length]} ${topics[(i + 2) % topics.length]} ${topics[(i + 4) % topics.length]}`;
    const parts = Array.from({ length: 70 }, (_, i) => section(i));
    parts.splice(35, 0, "Finance has approved forty-two lakh rupees for everything connected with taking the new app to market this autumn.");
    const boundary = "----aatmiq";
    const content = parts.join("\n\n");
    const up = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: { origin: APP_URL, cookie, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspaceId}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="Office handbook.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
      ),
    });
    const id = up.json().id;
    let d: any;
    for (let i = 0; i < 300; i++) {
      d = (await call("GET", `/api/documents/${id}`)).json;
      if (d.status !== "processing") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(d.status).toBe("ready");
    expect(d.embeddingModelId).toBeTruthy();
    expect(content.length).toBeGreaterThan(14_000);
    const chat = (await call("POST", "/api/chats", { workspaceId })).json;
    const r = await call("POST", `/api/chats/${chat.id}/messages`, { content: "What is the spending limit for the product release?", documentIds: [id] });
    expect(r.status).toBe(200);
    // The first excerpt the model is given is the passage with the answer.
    const first = /\[1\] Office handbook\.txt\n([\s\S]*?)(?=\n\[2\]|$)/.exec(lastSystem)?.[1] ?? "";
    if (!first.includes("forty-two lakh rupees")) console.log(lastSystem.slice(0, 3000));
    expect(first).toContain("forty-two lakh rupees");
  }, 180_000);
});
