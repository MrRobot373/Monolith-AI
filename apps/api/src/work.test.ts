/**
 * Work AI end to end through the API: a real DeepSeek Harness runtime, a scripted OpenAI-compatible
 * model and a fake SearXNG, against the test database (TEST_DATABASE_URL).
 */
import { connectorAccount, createDb, organization, sql, type DB } from "@aatmiq/db";
import { APPROVAL_PRESETS } from "@aatmiq/shared";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

let app: FastifyInstance;
let db: DB;
let close: () => Promise<void>;
let fake: Server;
let fakeUrl = "";
let apiUrl = "";
let workDir = "";
let storageDir = "";
const modelRequests: { role: string; content: unknown }[][] = [];
const mcpCalls: { name: string; arguments?: Record<string, unknown>; auth?: string }[] = [];
const oauth = { registered: [] as Record<string, unknown>[], authorize: [] as Record<string, string>[], grants: [] as string[], challenge: "" };
let lastTools: string[] = [];
let busyRefused = false;

/* ───────────── Fake model + SearXNG ───────────── */

const textOf = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");

function sse(res: import("node:http").ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

function fakeModel(body: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[] }, res: import("node:http").ServerResponse) {
  modelRequests.push(body.messages);
  lastTools = (body.tools ?? []).map((t) => t.function.name);
  const last = body.messages.at(-1)!;
  const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  const say = (t: string) => sse(res, [{ choices: [{ index: 0, delta: { content: t } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  if (last.role === "tool") return say(`Result: ${textOf(last.content).trim().slice(0, 300)}`);
  const userText = (m: { content: unknown }) => textOf(m.content).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
  const ask = [...body.messages].reverse().filter((m) => m.role === "user").map(userText).find((t) => t && !/^Current runtime context/.test(t)) ?? "";
  const asked = ask.split("</earlier-conversation>").at(-1)!;
  // A busy model server: the first try is refused, like Ollama's "temporarily overloaded".
  if (asked.includes("busy-server") && !busyRefused) {
    busyRefused = true;
    res.writeHead(503, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "model is temporarily overloaded, please retry shortly" } }));
  }
  let call: [string, unknown] | null = null;
  let m: RegExpExecArray | null;
  if ((m = /run: (.+)/s.exec(asked))) call = ["bash", { description: "Run it", command: m[1]!.trim() }];
  else if ((m = /search: (.+)/.exec(asked))) call = ["web_search", { queries: [m[1]!.trim()] }];
  else if ((m = /use (\S+) (\{.*\})/.exec(asked))) call = [m[1]!, JSON.parse(m[2]!)];
  if (!call) return say(`Hello! You said: ${asked.trim().slice(0, 100)}`);
  return sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    usage,
  ]);
}

/* ───────────── HTTP helpers ───────────── */

const owner = { cookie: "" };
async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
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
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, body: res.body };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, ms = 45_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 200));
  }
}

const getTask = async (id: string) => (await call("GET", `/api/work/tasks/${id}`)).json as { task: { status: string; error: string | null; inputTokens: number; result: string | null }; events: { seq: number; kind: string; data: any }[]; live: boolean };
const waitStatus = (id: string, ...statuses: string[]) =>
  waitFor(async () => {
    const t = await getTask(id);
    return statuses.includes(t.task.status) ? t : null;
  });

d("Work AI", () => {
  let workspaceId = "";
  let taskId = "";

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      if (req.url === "/v1/chat/completions") return fakeModel(JSON.parse(raw), res);
      if (req.url?.startsWith("/searx/search")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ results: [{ url: "https://intranet.example/travel", title: "Travel policy", content: "Economy under 6 hours." }] }));
      }
      if (req.url === "/mcp") {
        if (req.method !== "POST") return res.writeHead(405).end();
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return res.writeHead(202).end();
        const reply = (result: unknown) => {
          res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        };
        if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "notes", version: "1" } });
        if (msg.method === "tools/list")
          return reply({
            tools: [
              { name: "create_note", description: "Save a note", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
              { name: "list_notes", description: "List notes", inputSchema: { type: "object", properties: {} } },
            ],
          });
        if (msg.method === "tools/call") {
          mcpCalls.push({ ...msg.params, auth: req.headers.authorization });
          return reply({ content: [{ type: "text", text: `Saved note: ${msg.params.arguments?.text ?? ""}` }] });
        }
        return reply({});
      }
      // An MCP server protected by OAuth 2.1 (MCP authorization): discovery, registration, PKCE, refresh.
      const json = (status: number, obj: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(obj));
      };
      if (req.url === "/.well-known/oauth-protected-resource/oauth/mcp") return json(200, { resource: `${fakeUrl}/oauth/mcp`, authorization_servers: [`${fakeUrl}/oauth`] });
      if (req.url === "/.well-known/oauth-authorization-server/oauth")
        return json(200, {
          issuer: `${fakeUrl}/oauth`,
          authorization_endpoint: `${fakeUrl}/oauth/authorize`,
          token_endpoint: `${fakeUrl}/oauth/token`,
          registration_endpoint: `${fakeUrl}/oauth/register`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      if (req.url === "/oauth/register") {
        oauth.registered.push(JSON.parse(raw));
        return json(201, { client_id: "dyn-client" });
      }
      if (req.url?.startsWith("/oauth/authorize")) {
        const q = Object.fromEntries(new URL(req.url, fakeUrl).searchParams);
        oauth.authorize.push(q);
        oauth.challenge = q.code_challenge ?? "";
        res.writeHead(302, { location: `${q.redirect_uri}?code=code-1&state=${q.state}` });
        return res.end();
      }
      if (req.url === "/oauth/token") {
        const f = Object.fromEntries(new URLSearchParams(raw));
        oauth.grants.push(f.grant_type ?? "");
        if (f.grant_type === "authorization_code") {
          const ok = f.code === "code-1" && f.client_id === "dyn-client" && createHash("sha256").update(f.code_verifier ?? "").digest("base64url") === oauth.challenge;
          return ok ? json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 3600, token_type: "Bearer", email: "asha@mail.example" }) : json(400, { error: "invalid_grant" });
        }
        if (f.grant_type === "refresh_token" && f.refresh_token === "rt-1") return json(200, { access_token: "at-2", expires_in: 3600, token_type: "Bearer" });
        return json(400, { error: "invalid_grant" });
      }
      if (req.url === "/oauth/mcp") {
        const token = /^Bearer (at-\d)$/.exec(req.headers.authorization ?? "")?.[1];
        if (!token) return json(401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${fakeUrl}/.well-known/oauth-protected-resource/oauth/mcp"` });
        if (req.method !== "POST") return res.writeHead(405).end();
        const msg = JSON.parse(raw);
        if (msg.id === undefined) return res.writeHead(202).end();
        const reply = (result: unknown) => json(200, { jsonrpc: "2.0", id: msg.id, result }, { "mcp-session-id": "m1" });
        if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "mail", version: "1" } });
        if (msg.method === "tools/list")
          return reply({
            tools: [
              { name: "get_profile", description: "Who is signed in", inputSchema: { type: "object", properties: {} } },
              { name: "send_message", description: "Send an email", inputSchema: { type: "object", properties: { to: { type: "string" } }, required: ["to"] } },
            ],
          });
        if (msg.method === "tools/call") return reply({ content: [{ type: "text", text: `${msg.params.name} with token=${token}` }] });
        return reply({});
      }
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "fake-agent" }] }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`;

    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = {
      appUrl: APP_URL,
      databaseUrl: url ?? "",
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: false,
      port: 0,
      storageDir: (storageDir = await mkdtemp(join(tmpdir(), "aatmiq-files-"))),
      workDir: (workDir = await mkdtemp(join(tmpdir(), "aatmiq-work-"))),
    };
    app = await buildApp(db, cfg);
    apiUrl = await app.listen({ port: 0, host: "127.0.0.1" });

    expect((await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    const p = await call("POST", "/api/admin/providers", { name: "Fake", type: "openai_compatible", baseUrl: `${fakeUrl}/v1` });
    const m = await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "fake-agent", displayName: "Fake Agent", sections: ["chat", "work"] });
    expect(m.status).toBe(200);
    expect((await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id })).status).toBe(200);
    await db.update(organization).set({ workSettings: { searxngUrl: `${fakeUrl}/searx`, approvals: "risky" } });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
    await new Promise<void>((r) => fake?.close(() => r()));
  });

  it("runs a task: tool calls, files, metering", async () => {
    const r = await call("POST", "/api/work/tasks", { workspaceId, prompt: "run: echo hello-work > report.txt && cat report.txt" });
    expect(r.status).toBe(200);
    taskId = r.json.id;
    expect(r.json.title).toContain("run: echo");
    const t = await waitStatus(taskId, "completed", "failed");
    expect(t.task.error).toBeNull();
    expect(t.task.status).toBe("completed");
    const kinds = t.events.map((e) => e.kind);
    expect(kinds[0]).toBe("user");
    expect(t.events.find((e) => e.kind === "tool_call")?.data.name).toBe("bash");
    expect(t.events.find((e) => e.kind === "tool_result")?.data.text).toContain("hello-work");
    expect(t.task.result).toContain("hello-work");
    expect(t.task.inputTokens).toBeGreaterThan(0);

    const files = await call("GET", `/api/work/tasks/${taskId}/files`);
    expect(files.json.files.map((f: { path: string }) => f.path)).toContain("report.txt");
    const content = await call("GET", `/api/work/tasks/${taskId}/files/content?path=report.txt`);
    expect(content.body).toContain("hello-work");
    expect((await call("GET", `/api/work/tasks/${taskId}/files/content?path=../../etc/passwd`)).status).toBe(404);

    const usage = await db.execute(sql`select count(*)::int as n from usage_event where section = 'work'`);
    expect((usage as unknown as { n: number }[])[0]!.n).toBeGreaterThan(0);
    const list = await call("GET", `/api/work/tasks?workspaceId=${workspaceId}`);
    expect(list.json[0].id).toBe(taskId);
  }, 60_000);

  it("continues with a follow-up on the warm runtime", async () => {
    expect((await getTask(taskId)).live).toBe(true);
    await call("POST", `/api/work/tasks/${taskId}/messages`, { prompt: "thanks, all good?" });
    const t = await waitFor(async () => {
      const x = await getTask(taskId);
      return x.task.status === "completed" && x.events.filter((e) => e.kind === "user").length === 2 && x.task.result?.includes("thanks") ? x : null;
    });
    expect(t.task.result).toContain("You said: thanks");
  }, 60_000);

  it("asks before deleting: rejection keeps the file, approval removes it", async () => {
    await call("POST", `/api/work/tasks/${taskId}/messages`, { prompt: "run: rm report.txt" });
    await waitStatus(taskId, "needs_approval");
    const pending = await call("GET", "/api/work/approvals");
    expect(pending.json).toHaveLength(1);
    expect(pending.json[0]).toMatchObject({ toolName: "bash", reason: "Deletes files", detail: { command: "rm report.txt" } });
    expect((await call("POST", `/api/work/approvals/${pending.json[0].id}`, { decision: "reject" })).json.status).toBe("rejected");
    await waitStatus(taskId, "completed");
    expect((await call("GET", `/api/work/tasks/${taskId}/files`)).json.files).toHaveLength(1);
    expect((await call("POST", `/api/work/approvals/${pending.json[0].id}`, { decision: "approve" })).status).toBe(409);

    await call("POST", `/api/work/tasks/${taskId}/messages`, { prompt: "run: rm report.txt" });
    await waitStatus(taskId, "needs_approval");
    const again = (await call("GET", "/api/work/approvals")).json;
    await call("POST", `/api/work/approvals/${again[0].id}`, { decision: "approve" });
    await waitFor(async () => ((await call("GET", `/api/work/tasks/${taskId}/files`)).json.files.length === 0 ? true : null));
    await waitStatus(taskId, "completed");
    const t = await getTask(taskId);
    expect(t.events.filter((e) => e.kind === "approval").map((e) => e.data.status)).toEqual(["pending", "rejected", "pending", "approved"]);
  }, 90_000);

  it("searches the web through SearXNG", async () => {
    await call("POST", `/api/work/tasks/${taskId}/messages`, { prompt: "search: travel policy" });
    const t = await waitFor(async () => {
      const x = await getTask(taskId);
      return x.task.status === "completed" && x.events.some((e) => e.kind === "tool_result" && String(e.data.text).includes("intranet.example")) ? x : null;
    });
    expect(t.task.status).toBe("completed");
  }, 60_000);

  it("keeps the plan true: misnamed fields are fixed, open steps are ticked when the turn completes", async () => {
    const todos = [{ task: "Gather the numbers", status: "in-progress" }, { task: "Write the summary" }];
    const r = await call("POST", "/api/work/tasks", { workspaceId, prompt: `use todo_write ${JSON.stringify({ todos })}` });
    const t = await waitStatus(r.json.id, "completed", "failed");
    expect(t.task.status).toBe("completed");
    const plans = t.events.filter((e) => e.kind === "plan").map((e) => e.data.items);
    expect(plans[0]).toEqual([
      { content: "Gather the numbers", status: "in_progress" },
      { content: "Write the summary", status: "pending" },
    ]);
    expect(plans.at(-1)).toEqual([
      { content: "Gather the numbers", status: "completed" },
      { content: "Write the summary", status: "completed" },
    ]);
  }, 60_000);

  it("rides out a briefly overloaded model server", async () => {
    const r = await call("POST", "/api/work/tasks", { workspaceId, prompt: "busy-server: say hi" });
    const t = await waitStatus(r.json.id, "completed", "failed");
    expect(busyRefused).toBe(true);
    expect(t.task).toMatchObject({ status: "completed", error: null });
    expect(t.task.result).toContain("busy-server");
  }, 60_000);

  it("streams the timeline over SSE", async () => {
    const res = await fetch(`${apiUrl}/api/work/tasks/${taskId}/stream?after=2`, { headers: { cookie: owner.cookie } });
    const reader = res.body!.getReader();
    let text = "";
    while (!text.includes("event: ready")) {
      const { value, done } = await reader.read();
      if (done) break;
      text += new TextDecoder().decode(value);
    }
    await reader.cancel();
    const seqs = [...text.matchAll(/"seq":(\d+)/g)].map((m) => Number(m[1]));
    expect(Math.min(...seqs)).toBe(3);
    expect(text).toContain('"kind":"tool_result"');
  }, 30_000);

  it("restarts a stopped task from its history", async () => {
    await call("POST", `/api/work/tasks/${taskId}/cancel`);
    expect((await getTask(taskId)).live).toBe(false);
    await call("POST", `/api/work/tasks/${taskId}/messages`, { prompt: "what did we do?" });
    await waitFor(async () => {
      const x = await getTask(taskId);
      return x.task.status === "completed" && x.task.result?.includes("what did we do") ? x : null;
    });
    const seeded = JSON.stringify(modelRequests.at(-1));
    expect(seeded).toContain("earlier-conversation");
    expect(seeded).toContain("hello-work");
  }, 60_000);

  it("lets admins set the Work AI policy", async () => {
    const r = await call("GET", "/api/admin/work");
    expect(r.json.settings.searxngUrl).toContain("/searx");
    expect(r.json.licensed).toBe(true);
    const put = await call("PUT", "/api/admin/work", { maxConcurrentPerUser: 3, idleMinutes: 30 });
    expect(put.json).toMatchObject({ maxConcurrentPerUser: 3, idleMinutes: 30, approvals: "risky" });
    expect((await call("PUT", "/api/admin/work", { approvals: "sometimes" })).status).toBe(400);
    expect((await call("GET", "/api/work/info")).json).toMatchObject({ webSearch: true, approvals: "risky" });
  });

  it("gives the agent org and personal skills", async () => {
    const org = await call("POST", "/api/work/skills", { name: "Quarterly report", description: "Use when writing a quarterly report", body: "Always include a summary table.", scope: "org" });
    expect(org.status).toBe(200);
    expect(org.json).toMatchObject({ slug: "quarterly-report", editable: true });
    const mine = await call("POST", "/api/work/skills", { name: "Quarterly report", description: "My own variant", body: "Use bullet points." });
    expect(mine.json.scope).toBe("personal");
    expect((await call("GET", "/api/work/skills")).json).toHaveLength(2);

    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: "hello skills" });
    await waitStatus(t.json.id, "completed");
    const seen = JSON.stringify(modelRequests.at(-1));
    expect(seen).toContain("Use when writing a quarterly report");
    expect(seen).toContain("My own variant");
    expect((await call("DELETE", `/api/work/skills/${mine.json.id}`)).status).toBe(200);
  }, 60_000);

  it("ships the built-in skill library; admins can switch skills off", async () => {
    const lib = (await call("GET", "/api/work/skills/library")).json as { slug: string; category: string; enabled: boolean; files: string[] }[];
    expect(lib.length).toBeGreaterThanOrEqual(50);
    expect(lib.find((s) => s.slug === "excel-spreadsheets")).toMatchObject({ category: "Data", enabled: true, files: ["scripts/xlsx_helpers.py"] });
    const one = await call("GET", "/api/work/skills/library/code-review");
    expect(one.json.body).toContain("## Done when");

    expect((await call("PATCH", "/api/work/skills/library/seo", { enabled: false })).json).toEqual({ slug: "seo", enabled: false });
    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: "hello library" });
    await waitStatus(t.json.id, "completed");
    const seen = JSON.stringify(modelRequests.at(-1));
    expect(seen).toContain("`word-documents`");
    expect(seen).toContain("`code-review`");
    expect(seen).not.toContain("`seo`");
    // The skill's helper scripts are in the task's skills folder, readable by the task.
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(workDir, t.json.id, "runtime", "skills", "word-documents", "scripts"))).toEqual(["md_to_docx.py"]);

    expect((await call("GET", "/api/work/skills/library")).json.find((s: { slug: string }) => s.slug === "seo").enabled).toBe(false);
    await call("PATCH", "/api/work/skills/library/seo", { enabled: true });
    expect((await call("PATCH", "/api/work/skills/library/no-such-skill", { enabled: false })).status).toBe(404);
  }, 60_000);

  it("connects MCP servers and asks before matching tools", async () => {
    const c = await call("POST", "/api/admin/connectors", { name: "notes", displayName: "Notes", url: `${fakeUrl}/mcp`, headers: { authorization: "Bearer notes-secret" }, approveTools: "create_*" });
    expect(c.status).toBe(200);
    expect(c.json.headerNames).toEqual(["authorization"]);
    expect(JSON.stringify((await call("GET", "/api/admin/connectors")).json)).not.toContain("notes-secret");
    const probe = await call("POST", `/api/admin/connectors/${c.json.id}/test`);
    expect(probe.json).toMatchObject({ ok: true, serverName: "notes" });
    expect(probe.json.tools.map((x: { name: string }) => x.name)).toEqual(["create_note", "list_notes"]);

    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: 'use mcp__notes__create_note {"text":"buy milk"}' });
    await waitStatus(t.json.id, "needs_approval", "completed", "failed");
    expect(lastTools).toContain("mcp__notes__create_note");
    const pending = (await call("GET", "/api/work/approvals")).json;
    expect(pending[0]).toMatchObject({ toolName: "mcp__notes__create_note" });
    await call("POST", `/api/work/approvals/${pending[0].id}`, { decision: "approve" });
    const done = await waitStatus(t.json.id, "completed", "failed");
    expect(done.task.error).toBeNull();
    // Through Aatmiq's MCP proxy: the runtime never had the header, the server still got it.
    expect(mcpCalls.at(-1)).toMatchObject({ name: "create_note", arguments: { text: "buy milk" }, auth: "Bearer notes-secret" });
    expect(done.events.find((e) => e.kind === "tool_result")?.data.text).toContain("Saved note: buy milk");
    await call("PATCH", `/api/admin/connectors/${c.json.id}`, { enabled: false });
  }, 60_000);

  it("connects OAuth apps per person and calls them through the proxy, refreshing tokens", async () => {
    const c = await call("POST", "/api/admin/connectors", { name: "mail", displayName: "Mail", url: `${fakeUrl}/oauth/mcp`, auth: "oauth" });
    expect(c.status).toBe(200);
    expect(c.json).toMatchObject({ auth: "oauth", approveTools: APPROVAL_PRESETS.changes, accounts: 0 });
    const mine = async () => ((await call("GET", "/api/connectors")).json as { name: string; connected: boolean; account: { label: string } | null }[]).find((x) => x.name === "mail")!;
    expect(await mine()).toMatchObject({ connected: false });

    // Not connected yet: tasks don't get its tools.
    const before = await call("POST", "/api/work/tasks", { workspaceId, prompt: "hello there" });
    await waitStatus(before.json.id, "completed", "failed");
    expect(lastTools.some((t) => t.startsWith("mcp__mail__"))).toBe(false);

    // Sign in: dynamic registration, PKCE, resource indicator, then the callback stores the tokens.
    const start = await app.inject({ method: "POST", url: `/api/connectors/${c.json.id}/connect`, headers: { origin: APP_URL, cookie: owner.cookie, "content-type": "application/json" }, payload: "{}" });
    expect(start.statusCode).toBe(200);
    const authUrl = new URL(start.json().url);
    expect(authUrl.searchParams.get("client_id")).toBe("dyn-client");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("resource")).toBe(`${fakeUrl}/oauth/mcp`);
    expect(oauth.registered[0]).toMatchObject({ redirect_uris: [`${APP_URL}/api/connectors/oauth/callback`], token_endpoint_auth_method: "none" });
    const stateCookie = String(start.headers["set-cookie"]).split(";")[0];
    const back = await fetch(authUrl, { redirect: "manual" });
    const cb = new URL(back.headers.get("location")!);
    const done = await app.inject({ method: "GET", url: `/api/connectors/oauth/callback${cb.search}`, headers: { cookie: `${owner.cookie}; ${stateCookie}` } });
    expect(done.statusCode).toBe(302);
    expect(done.headers.location).toBe("/app/work/connections?connected=mail");
    expect(await mine()).toMatchObject({ connected: true, account: { label: "asha@mail.example" } });
    const [acc] = await db.select().from(connectorAccount);
    expect(acc!.accessTokenEnc).not.toContain("at-1");

    // A replayed callback is refused.
    const replay = await app.inject({ method: "GET", url: `/api/connectors/oauth/callback${cb.search}`, headers: { cookie: owner.cookie } });
    expect(replay.headers.location).toContain("connector_error=");

    // The task gets the tools, reads freely, and the call carries the person's own token.
    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: "use mcp__mail__get_profile {}" });
    const r1 = await waitStatus(t.json.id, "completed", "failed", "needs_approval");
    expect(r1.task.status).toBe("completed");
    expect(lastTools).toContain("mcp__mail__send_message");
    expect(r1.events.find((e) => e.kind === "tool_result")?.data.text).toContain("get_profile with token=at-1");
    expect(JSON.stringify(modelRequests.at(-1))).toContain("Mail (asha@mail.example)");

    // An expired token is refreshed on the way; sending asks first.
    await db.update(connectorAccount).set({ expiresAt: new Date(Date.now() - 1000) });
    const t2 = await call("POST", "/api/work/tasks", { workspaceId, prompt: 'use mcp__mail__send_message {"to":"boss@example.com"}' });
    await waitStatus(t2.json.id, "needs_approval");
    const pending = (await call("GET", "/api/work/approvals")).json;
    expect(pending[0]).toMatchObject({ toolName: "mcp__mail__send_message" });
    await call("POST", `/api/work/approvals/${pending[0].id}`, { decision: "approve" });
    const r2 = await waitStatus(t2.json.id, "completed", "failed");
    expect(r2.events.find((e) => e.kind === "tool_result")?.data.text).toContain("send_message with token=at-2");
    expect(oauth.grants).toEqual(["authorization_code", "refresh_token"]);

    // Disconnecting removes it from tasks again.
    expect((await call("DELETE", `/api/connectors/${c.json.id}/connection`)).status).toBe(200);
    expect(await mine()).toMatchObject({ connected: false, account: null });
    await call("PATCH", `/api/admin/connectors/${c.json.id}`, { enabled: false });
  }, 90_000);

  it("schedules recurring tasks", async () => {
    expect((await call("POST", "/api/work/schedules", { workspaceId, name: "Too often", prompt: "x", cron: "* * * * *" })).status).toBe(400);
    expect((await call("POST", "/api/work/schedules", { workspaceId, name: "Bad", prompt: "x", cron: "0 9 * *" })).status).toBe(400);
    expect((await call("POST", "/api/work/schedules", { workspaceId, name: "Bad tz", prompt: "x", cron: "0 9 * * *", timezone: "Mars/Olympus" })).status).toBe(400);
    const s = await call("POST", "/api/work/schedules", { workspaceId, name: "Morning brief", prompt: "good morning", cron: "0 9 * * 1-5", timezone: "Asia/Kolkata" });
    expect(s.status).toBe(200);
    expect(new Date(s.json.nextRunAt).getUTCHours()).toBe(3);
    expect(new Date(s.json.nextRunAt).getUTCMinutes()).toBe(30);
    const preview = await call("GET", "/api/work/schedules/preview?cron=0%209%20*%20*%201-5&timezone=UTC");
    expect(preview.json.runs).toHaveLength(3);

    const run = await call("POST", `/api/work/schedules/${s.json.id}/run`);
    const t = await waitStatus(run.json.taskId, "completed", "failed");
    expect(t.task.result).toContain("good morning");
    const list = await call("GET", `/api/work/schedules?workspaceId=${workspaceId}`);
    expect(list.json[0]).toMatchObject({ lastTaskId: run.json.taskId, lastStatus: "completed" });
    const off = await call("PATCH", `/api/work/schedules/${s.json.id}`, { enabled: false });
    expect(off.json.nextRunAt).toBeNull();
  }, 60_000);

  it.runIf(process.getuid?.() === 0)("isolates tasks: own Unix user, no access to other tasks or documents", async () => {
    const other = join(workDir, taskId, "files");
    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: `run: id -u; ls ${other}; ls ${storageDir}` });
    const done = await waitStatus(t.json.id, "completed", "failed");
    const out = String(done.events.find((e) => e.kind === "tool_result")?.data.text);
    expect(Number(out.split("\n")[0])).toBeGreaterThanOrEqual(100000);
    expect(out.match(/permission denied/gi)?.length).toBe(2);
  }, 60_000);

  it("a runtime that can't start fails its task without blocking the next one", async () => {
    process.env.AATMIQ_DSH_CLI = "/nonexistent/dsh.js";
    const broken = await call("POST", "/api/work/tasks", { workspaceId, prompt: "hello?" });
    const failed = await waitStatus(broken.json.id, "failed", "completed");
    delete process.env.AATMIQ_DSH_CLI;
    expect(failed.task.status).toBe("failed");
    expect(failed.task.error).toMatch(/start|Cannot find module/i);
    const next = await call("POST", "/api/work/tasks", { workspaceId, prompt: "still there?" });
    expect((await waitStatus(next.json.id, "completed", "failed")).task.status).toBe("completed");
  }, 60_000);

  it("guards the internal API and cancels running work", async () => {
    const r = await fetch(`${apiUrl}/api/internal/work/approvals`, { method: "POST", headers: { authorization: "Bearer nope", "content-type": "application/json" }, body: "{}" });
    expect(r.status).toBe(401);

    const t = await call("POST", "/api/work/tasks", { workspaceId, prompt: "run: sleep 20" });
    await waitFor(async () => ((await getTask(t.json.id)).events.some((e) => e.kind === "tool_call") ? true : null));
    await call("POST", `/api/work/tasks/${t.json.id}/cancel`);
    const x = await getTask(t.json.id);
    expect(x.task.status).toBe("cancelled");
    expect(x.live).toBe(false);
    expect((await call("DELETE", `/api/work/tasks/${t.json.id}`)).status).toBe(200);
    expect((await call("GET", `/api/work/tasks/${t.json.id}`)).status).toBe(404);
  }, 60_000);
});
