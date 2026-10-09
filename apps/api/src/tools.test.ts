/**
 * Every tool the Work AI agent has, alone and in the chains people use: files, shell, plan, web
 * search, web pages, the browser, the organization's documents, skills and connected apps. A real
 * DeepSeek Harness runtime runs each task; a scripted model plays the agent, one step per model
 * call, against the test database (TEST_DATABASE_URL). The browser steps need Chromium.
 *
 * A prompt `steps: [["tool", {args}], …]` makes the model call each tool in turn and then answer
 * with what the tools returned. Arguments may use what an earlier step returned:
 *   {{doc}}        the first document_id an earlier step returned
 *   {{job}}        the latest background job an earlier step started
 *   {{png}}        the first .png file an earlier step returned
 *   {{ref:Label}}  the browser's number for the element labelled Label, in the latest page view
 */
import { createDb, organization, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { findChromium } from "./services/browser";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;
const hasBrowser = (() => {
  try {
    const p = findChromium();
    return !!p && existsSync(p);
  } catch {
    return false;
  }
})();

let app: FastifyInstance;
let db: DB;
let close: () => Promise<void>;
let fake: Server;
let fakeUrl = "";
let workDir = "";
let lastTools: string[] = [];
let modelId = "";
let imagesSeen = 0;
const mcpCalls: { name: string; arguments?: Record<string, unknown> }[] = [];

/* ───────────── The scripted agent ───────────── */

type Msg = { role: string; content: unknown; tool_calls?: unknown[] };
const textOf = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");

function sse(res: import("node:http").ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** Fill {{doc}} and {{ref:Label}} from what earlier steps returned. */
function fill(value: unknown, results: string[]): unknown {
  if (typeof value === "string") {
    const whole = /^\{\{ref:(.+)\}\}$/.exec(value);
    const refOf = (label: string) => {
      for (const r of [...results].reverse()) {
        const m = new RegExp(`\\[(\\d+)\\] [a-z]+ "${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).exec(r);
        if (m) return Number(m[1]);
      }
      return 0;
    };
    if (whole) return refOf(whole[1]!);
    return value
      .replace(/\{\{doc\}\}/g, () => /document_id: ([0-9a-f-]{36})/.exec(results.join("\n"))?.[1] ?? "none")
      .replace(/\{\{png\}\}/g, () => /[\w./-]+\.png/.exec(results.join("\n"))?.[0] ?? "none")
      .replace(/\{\{agent\}\}/g, () => [...results.join("\n").matchAll(/started subagent ([\w-]+)/g)].at(-1)?.[1] ?? "none")
      .replace(/\{\{job\}\}/g, () => [...results.join("\n").matchAll(/moved to background job ([\w-]+)/g)].at(-1)?.[1] ?? "none");
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, results));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, results)]));
  return value;
}

function fakeModel(body: { messages: Msg[]; tools?: { function: { name: string } }[] }, res: import("node:http").ServerResponse) {
  lastTools = (body.tools ?? []).map((t) => t.function.name);
  imagesSeen = JSON.stringify(body.messages).split('"image_url"').length - 1;
  const usage = { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } };
  const say = (t: string) => sse(res, [{ choices: [{ index: 0, delta: { content: t } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  // This turn: everything after the person's message that carries the script.
  const start = body.messages.findLastIndex((m) => m.role === "user" && /steps: \[/.test(textOf(m.content)));
  if (start < 0) return say("Hello.");
  const script = /steps: (\[[\s\S]*\])/.exec(textOf(body.messages[start]!.content).split("</earlier-conversation>").at(-1)!)?.[1];
  const steps = JSON.parse(script ?? "[]") as [string, Record<string, unknown>][];
  const results = body.messages.slice(start + 1).filter((m) => m.role === "tool").map((m) => textOf(m.content));
  // Placeholders may use any earlier result in the conversation (a follow-up builds on the last turn).
  const earlier = body.messages.filter((m) => m.role === "tool").map((m) => textOf(m.content));
  const next = steps[results.length];
  if (!next) return say(`Done.\n${results.map((r, i) => `[${i + 1}] ${r.slice(0, 2000)}`).join("\n")}`);
  return sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${results.length}_${Date.now()}`, type: "function", function: { name: next[0], arguments: JSON.stringify(fill(next[1], earlier)) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    usage,
  ]);
}

/* ───────────── HTTP helpers ───────────── */

type Session = { cookie: string };
const owner: Session = { cookie: "" };

async function callAs(s: Session, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await app.inject({
    method,
    url: path,
    headers: { origin: APP_URL, ...(s.cookie ? { cookie: s.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers["set-cookie"];
  if (set) s.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, body: res.body };
}
const call = (method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) => callAs(owner, method, path, body);

async function upload(s: Session, workspaceId: string, name: string, content: string, scope: "private" | "workspace" = "private") {
  const b = "----aatmiq-tools";
  const payload =
    `--${b}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspaceId}\r\n--${b}\r\nContent-Disposition: form-data; name="scope"\r\n\r\n${scope}\r\n` +
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${b}--\r\n`;
  const res = await app.inject({ method: "POST", url: "/api/documents", headers: { origin: APP_URL, cookie: s.cookie, "content-type": `multipart/form-data; boundary=${b}` }, payload });
  expect(res.statusCode).toBe(200);
  const doc = res.json() as { id: string };
  await waitFor(async () => ((await callAs(s, "GET", `/api/documents/${doc.id}`)).json.status === "ready" ? true : null));
  return doc.id;
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

type Task = { task: { id: string; status: string; error: string | null; result: string | null }; events: { kind: string; data: any }[] };
const getTask = async (s: Session, id: string) => (await callAs(s, "GET", `/api/work/tasks/${id}`)).json as Task;
const waitStatus = (s: Session, id: string, ...statuses: string[]) =>
  waitFor(async () => {
    const t = await getTask(s, id);
    return statuses.includes(t.task.status) ? t : null;
  }, 90_000);

/** Run a scripted task to the end; returns the tool calls and their results, in order. */
async function run(workspaceId: string, steps: [string, Record<string, unknown>][], s: Session = owner) {
  const r = await callAs(s, "POST", "/api/work/tasks", { workspaceId, prompt: `steps: ${JSON.stringify(steps)}` });
  expect(r.status).toBe(200);
  const t = await waitStatus(s, r.json.id, "completed", "failed", "needs_approval");
  return summarize(t);
}
function summarize(t: Task) {
  // Each call with its own result (a helper's steps can interleave with the agent's).
  const callEvents = t.events.filter((e) => e.kind === "tool_call");
  const resultOf = new Map(t.events.filter((e) => e.kind === "tool_result").map((e) => [String(e.data.callId), String(e.data.text ?? "")]));
  const calls = callEvents.map((e) => e.data.name as string);
  const results = callEvents.map((e) => resultOf.get(String(e.data.callId)) ?? "");
  return { task: t.task, calls, results, id: t.task.id, files: () => call("GET", `/api/work/tasks/${t.task.id}/files`).then((x) => (x.json.files as { path: string }[]).map((f) => f.path)) };
}
const fileOf = async (taskId: string, path: string) => (await call("GET", `/api/work/tasks/${taskId}/files/content?path=${encodeURIComponent(path)}`)).body;

/* ───────────── A web site and an app to connect ───────────── */

function siteAndApps(req: import("node:http").IncomingMessage, raw: string, res: import("node:http").ServerResponse) {
  const html = (body: string, title: string) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>${title}</title><body>${body}</body>`);
  };
  const u = new URL(req.url ?? "/", "http://x");
  if (u.pathname === "/site/") return html(`<h1>Acme intranet</h1><p>Welcome.</p><a href="/site/holidays">Holiday calendar</a><form action="/site/find"><label for="office">Office</label><select id="office" name="office"><option>Pune</option><option>Mumbai</option></select><label for="q">Find</label><input id="q" name="q"><button>Go</button></form>`, "Intranet");
  if (u.pathname === "/site/holidays") return html("<h1>Holidays 2026</h1><p>Diwali: 8 November. Christmas: 25 December.</p>", "Holidays");
  if (u.pathname === "/site/find") return html(`<h1>Found: ${u.searchParams.get("q")} in ${u.searchParams.get("office")}</h1>`, "Find");
  if (u.pathname === "/site/rates.txt") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("Hotel rate cap: 9,000 rupees a night.");
  }
  if (u.pathname.startsWith("/searx/search")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ results: [{ url: "https://intranet.example/travel", title: "Travel policy", content: "Economy under 6 hours." }] }));
  }
  if (u.pathname === "/mcp") {
    if (req.method !== "POST") return res.writeHead(405).end();
    const msg = JSON.parse(raw);
    if (msg.id === undefined) return res.writeHead(202).end();
    const reply = (result: unknown) => {
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "s1" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    };
    if (msg.method === "initialize") return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "crm", version: "1" } });
    if (msg.method === "tools/list")
      return reply({
        tools: [
          { name: "find_customer", description: "Find a customer", inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
          { name: "add_note", description: "Add a note to a customer", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
        ],
      });
    if (msg.method === "tools/call") {
      mcpCalls.push(msg.params);
      const text = msg.params.name === "find_customer" ? `Customer ${msg.params.arguments?.name}: Bharat Steel, renewal due 1 December, owner Ravi.` : `Note saved: ${msg.params.arguments?.text}`;
      return reply({ content: [{ type: "text", text }] });
    }
    return reply({});
  }
  res.writeHead(404).end();
}

/* ───────────── The suite ───────────── */

d("Work AI tools", () => {
  let workspaceId = "";
  const handbook = [
    "# Acme travel handbook",
    "",
    ...Array.from({ length: 30 }, (_, i) => `Section ${i + 1}. General rules about offices, meetings and paperwork number ${i + 1}. Keep receipts and file them within a week.`),
    "",
    "## Flights",
    "Flights under six hours are booked in economy class. Longer flights may be booked in premium economy with a manager's approval.",
    "",
    "## Hotels",
    "Hotels are capped at 9,000 rupees a night in metro cities and 6,000 elsewhere.",
  ].join("\n");

  beforeAll(async () => {
    fake = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      if (req.url === "/v1/chat/completions") return fakeModel(JSON.parse(raw), res);
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "fake-agent" }] }));
      }
      return siteAndApps(req, raw, res);
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
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: (workDir = await mkdtemp(join(tmpdir(), "aatmiq-work-"))),
    };
    app = await buildApp(db, cfg);
    await app.listen({ port: 0, host: "127.0.0.1" });

    expect((await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
    const p = await call("POST", "/api/admin/providers", { name: "Fake", type: "openai_compatible", baseUrl: `${fakeUrl}/v1` });
    const m = await call("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "fake-agent", displayName: "Fake Agent", sections: ["chat", "work"] });
    modelId = m.json.id;
    expect((await call("PUT", `/api/admin/workspaces/${workspaceId}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id })).status).toBe(200);
    await db.update(organization).set({ workSettings: { searxngUrl: `${fakeUrl}/searx`, approvals: "risky", browser: hasBrowser, browserAllowedHosts: ["127.0.0.1"] } });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
    // Runtimes and the browser may leave keep-alive connections to the fake servers open.
    fake?.closeAllConnections();
    await new Promise<void>((r) => fake?.close(() => r()));
  });

  const ALL_TOOLS = [
    "bash", "read", "write", "edit", "glob", "grep", "read_image", "todo_write", "web_search", "web_fetch", "skill",
    "subagent", "subagent_fork", "send_message", "list_agents", "interrupt_agent", "job_list", "job_output", "job_kill",
    "documents_search", "documents_read", "documents_save",
  ];
  const BROWSER_TOOLS = ["browser_open", "browser_click", "browser_type", "browser_select", "browser_back", "browser_read", "browser_screenshot"];

  it("offers every tool", async () => {
    const t = await run(workspaceId, []);
    expect(t.task.status).toBe("completed");
    expect([...lastTools].sort()).toEqual([...ALL_TOOLS, ...(hasBrowser ? BROWSER_TOOLS : [])].sort());
  }, 60_000);

  it("files: write → read → edit → grep → glob → bash in one turn", async () => {
    const t = await run(workspaceId, [
      ["write", { file_path: "notes/plan.md", content: "# Plan\nBudget: 40 lakh\nOwner: Ravi\n" }],
      ["read", { file_path: "notes/plan.md" }],
      ["edit", { file_path: "notes/plan.md", old_string: "40 lakh", new_string: "42 lakh" }],
      ["grep", { pattern: "Budget" }],
      ["glob", { pattern: "*.md" }],
      ["bash", { command: "wc -l < notes/plan.md && cat notes/plan.md", description: "Count lines and show the plan" }],
    ]);
    expect(t.task.status).toBe("completed");
    expect(t.calls).toEqual(["write", "read", "edit", "grep", "glob", "bash"]);
    expect(t.results[1]).toContain("Budget: 40 lakh");
    expect(t.results[3]).toContain("plan.md");
    expect(t.results[4]).toContain("notes/plan.md");
    expect(t.results[5]).toMatch(/3\s[\s\S]*Budget: 42 lakh/);
    expect(await fileOf(t.id, "notes/plan.md")).toBe("# Plan\nBudget: 42 lakh\nOwner: Ravi\n");
    expect(t.task.result).toContain("Done.");
  }, 90_000);

  it("plan and shell: the plan people see follows the work", async () => {
    const t = await run(workspaceId, [
      ["todo_write", { todos: [{ content: "Count the files", status: "in_progress" }, { content: "Write the count", status: "pending" }] }],
      ["bash", { command: "printf 'files: %s\\n' $(ls | wc -l) > count.txt", description: "Count files" }],
      ["todo_write", { todos: [{ content: "Count the files", status: "completed" }, { content: "Write the count", status: "completed" }] }],
    ]);
    expect(t.task.status).toBe("completed");
    const full = await getTask(owner, t.id);
    const plans = full.events.filter((e) => e.kind === "plan").map((e) => e.data.items.map((i: { status: string }) => i.status));
    expect(plans[0]).toEqual(["in_progress", "pending"]);
    expect(plans.at(-1)).toEqual(["completed", "completed"]);
    expect(await fileOf(t.id, "count.txt")).toMatch(/^files: \d+/);
  }, 90_000);

  it("web: search → fetch a page (never a private address) → write what it found", async () => {
    const t = await run(workspaceId, [
      ["web_search", { queries: ["travel policy"] }],
      ["web_fetch", { url: `${fakeUrl}/site/rates.txt` }],
      ["write", { file_path: "travel.md", content: "Economy under 6 hours. Hotel cap 9,000." }],
    ]);
    expect(t.task.status).toBe("completed");
    expect(t.results[0]).toContain("intranet.example/travel");
    // The test site is on this machine; web_fetch refuses private and internal addresses.
    expect(t.results[1]).toMatch(/non-public IP address/);
    expect(await t.files()).toContain("travel.md");
  }, 90_000);

  describe("the organization's documents", () => {
    const maya: Session = { cookie: "" };
    let handbookId = "";
    let mayaPrivateId = "";

    beforeAll(async () => {
      handbookId = await upload(owner, workspaceId, "Travel handbook.md", handbook, "workspace");
      await upload(owner, workspaceId, "Canteen menu.txt", "Monday: dosa. Tuesday: rajma chawal. Wednesday: biryani.");
      const inv = await call("POST", "/api/admin/invites", { email: "maya@acme.test", workspaces: [{ workspaceId, role: "member" }] });
      await callAs(maya, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name: "Maya Member", password: "a-good-password-1" });
      mayaPrivateId = await upload(maya, workspaceId, "Maya salary slip.txt", "Maya's hotel allowance and salary: 1,20,000 a month. Private.");
    }, 90_000);

    it("search → read the whole document → write a summary → save it to Documents", async () => {
      const t = await run(workspaceId, [
        ["documents_search", { query: "hotel nightly cap in metro cities", limit: 3 }],
        ["documents_read", { document_id: "{{doc}}" }],
        ["write", { file_path: "summary.md", content: "# Travel rules\n\n- Economy under six hours.\n- Hotels: 9,000 a night in metros.\n" }],
        ["documents_save", { path: "summary.md", name: "Travel rules summary" }],
      ]);
      expect(t.task.status).toBe("completed");
      expect(t.calls).toEqual(["documents_search", "documents_read", "write", "documents_save"]);
      expect(t.results[0]).toContain("Travel handbook.md");
      expect(t.results[0]).toContain(`document_id: ${handbookId}`);
      expect(t.results[0]).toContain("9,000 rupees a night");
      expect(t.results[1]).toContain("Document: Travel handbook.md");
      expect(t.results[1]).toContain("## Flights");
      expect(t.results[1]).not.toContain("(more:");
      expect(t.results[3]).toMatch(/Saved Travel rules summary\.md to the person's documents/);

      // The saved file is the person's private document, read and searchable like an upload.
      const docs = (await call("GET", `/api/documents?workspaceId=${workspaceId}`)).json as { id: string; name: string; scope: string; status: string }[];
      const saved = docs.find((x) => x.name === "Travel rules summary.md")!;
      expect(saved).toMatchObject({ scope: "private" });
      await waitFor(async () => ((await call("GET", `/api/documents/${saved.id}`)).json.status === "ready" ? true : null));
      const again = await run(workspaceId, [["documents_search", { query: "Travel rules summary metros" }]]);
      expect(again.results[0]).toContain("Travel rules summary.md");
      const usage = await db.execute(sql`select count(*)::int as n from audit_log where action = 'document.uploaded' and meta->>'fromTask' = ${t.id}`);
      expect((usage as unknown as { n: number }[])[0]!.n).toBe(1);
    }, 120_000);

    it("sees only what the task's person may open", async () => {
      // Maya's private document never reaches Asha's agent, by search or by id.
      const asha = await run(workspaceId, [
        ["documents_search", { query: "salary slip hotel allowance" }],
        ["documents_read", { document_id: mayaPrivateId }],
      ]);
      expect(asha.task.status).toBe("completed");
      expect(asha.results.join("\n")).not.toContain("1,20,000");
      expect(asha.results[1]).toMatch(/Document not found/);
      // Maya's agent finds her own document and the shared handbook, not Asha's private menu.
      const mine = await run(workspaceId, [["documents_search", { query: "salary allowance hotel menu dosa" }]], maya);
      expect(mine.results[0]).toContain("Maya salary slip.txt");
      expect(mine.results[0]).not.toContain("Canteen menu.txt");
      const shared = await run(workspaceId, [["documents_read", { document_id: handbookId }]], maya);
      expect(shared.results[0]).toContain("Hotels are capped");
    }, 120_000);

    it("long documents come in parts; mistakes come back as plain answers", async () => {
      const long = await upload(owner, workspaceId, "Minutes.txt", Array.from({ length: 400 }, (_, i) => `Minute ${i + 1}: the committee discussed item ${i + 1} at length and agreed to revisit it.`).join("\n"));
      const t = await run(workspaceId, [
        ["documents_read", { document_id: long }],
        ["documents_read", { document_id: long, offset: 12_000 }],
        ["documents_read", { document_id: "not-a-real-id" }],
        ["documents_save", { path: "nothing-here.pdf" }],
        ["documents_save", { path: "../../../etc/passwd" }],
        ["write", { file_path: "tool.exe", content: "MZ" }],
        ["documents_save", { path: "tool.exe" }],
        ["documents_search", { query: "zebra quantum croissant" }],
      ]);
      expect(t.task.status).toBe("completed");
      expect(t.results[0]).toContain("Minute 1:");
      expect(t.results[0]).toMatch(/more: call documents_read with offset 12000/);
      expect(t.results[1]).not.toContain("Minute 1:");
      expect(t.results[1]).toContain("Minute 200:");
      expect(t.results[2]).toMatch(/Document not found/);
      expect(t.results[3]).toMatch(/no file nothing-here\.pdf/);
      expect(t.results[4]).toMatch(/no file \.\.\/\.\.\/\.\.\/etc\/passwd/);
      expect(t.results[6]).toMatch(/can't be a document/);
      expect(t.results[7]).toMatch(/No passages/);
    }, 120_000);

    it("a report end to end: find facts → draft → Word file with the skill → save → searchable", async () => {
      const t = await run(workspaceId, [
        ["documents_search", { query: "flights economy premium approval" }],
        ["write", { file_path: "draft.md", content: "# Travel brief\n\n| Trip | Class |\n|---|---|\n| Under 6 hours | Economy |\n| Longer | Premium economy (manager approves) |\n\nPrepared for the zanzibar offsite.\n" }],
        ["skill", { name: "word-documents" }],
        ["bash", { command: 'python3 "$(find .. -path "*word-documents/scripts/md_to_docx.py" | head -1)" draft.md "Travel brief.docx" --title "Travel brief" && ls -la "Travel brief.docx"', description: "Convert the draft to Word" }],
        ["documents_save", { path: "Travel brief.docx" }],
        ["bash", { command: "python3 -c \"import openpyxl; wb=openpyxl.Workbook(); ws=wb.active; ws.append(['City','Hotel cap']); ws.append(['Mumbai',9000]); ws.append(['Nashik',6000]); wb.save('caps.xlsx')\"", description: "Make a spreadsheet" }],
        ["documents_save", { path: "caps.xlsx", name: "Hotel caps" }],
      ]);
      expect(t.task.status).toBe("completed");
      expect(t.results[0]).toContain("Travel handbook.md");
      expect(t.results[2]).toContain("md_to_docx.py");
      expect(t.results[3]).toContain("Travel brief.docx");
      expect(t.results[4]).toMatch(/Saved Travel brief\.docx/);
      expect(t.results[6]).toMatch(/Saved Hotel caps\.xlsx/);
      // Aatmiq reads both like uploads: the Word table and the spreadsheet rows are searchable.
      const docs = (await call("GET", `/api/documents?workspaceId=${workspaceId}`)).json as { id: string; name: string }[];
      for (const name of ["Travel brief.docx", "Hotel caps.xlsx"]) {
        const id = docs.find((x) => x.name === name)!.id;
        const ready = await waitFor(async () => {
          const x = (await call("GET", `/api/documents/${id}`)).json;
          return x.status === "ready" || x.status === "failed" ? x : null;
        });
        expect(ready.status, name).toBe("ready");
      }
      const found = await run(workspaceId, [
        ["documents_search", { query: "zanzibar offsite premium economy" }],
        ["documents_search", { query: "Nashik hotel cap" }],
      ]);
      expect(found.results[0]).toContain("Travel brief.docx");
      expect(found.results[1]).toContain("Hotel caps.xlsx");
      expect(found.results[1]).toContain("6000");
    }, 180_000);

    it("project tasks find the project's sources; follow-ups keep every tool", async () => {
      const proj = (await call("POST", "/api/projects", { workspaceId, name: "Offsite" })).json;
      await call("POST", `/api/projects/${proj.id}/sources/note`, { title: "Venue", content: "The offsite venue is the Lonavala riverside resort, 14 to 16 January." });
      await waitFor(async () => ((await call("GET", `/api/projects/${proj.id}`)).json.sources.every((x: { status: string }) => x.status === "ready") ? true : null));
      const r = await call("POST", "/api/work/tasks", { workspaceId, projectId: proj.id, prompt: `steps: ${JSON.stringify([["documents_search", { query: "offsite venue dates" }]])}` });
      const first = summarize(await waitStatus(owner, r.json.id, "completed", "failed"));
      expect(first.results[0]).toContain("Venue.md");
      expect(first.results[0]).toContain("Lonavala");
      // A follow-up on the same (warm) runtime: read it whole, write, save.
      await call("POST", `/api/work/tasks/${r.json.id}/messages`, {
        prompt: `steps: ${JSON.stringify([["documents_read", { document_id: "{{doc}}" }], ["bash", { command: "echo 'Venue: Lonavala, 14-16 Jan' > venue.txt", description: "Note the venue" }], ["documents_save", { path: "venue.txt" }]])}`,
      });
      const second = await waitFor(async () => {
        const x = await getTask(owner, r.json.id);
        return x.task.status === "completed" && x.events.filter((e) => e.kind === "user").length === 2 ? summarize(x) : null;
      }, 90_000);
      expect(second.calls.slice(-3)).toEqual(["documents_read", "bash", "documents_save"]);
      expect(second.results.at(-3)).toContain("Lonavala riverside resort");
      expect(second.results.at(-1)).toMatch(/Saved venue\.txt/);
    }, 150_000);

    it("asks before saving when every action is reviewed", async () => {
      await db.update(organization).set({ workSettings: { searxngUrl: `${fakeUrl}/searx`, approvals: "always", browser: hasBrowser, browserAllowedHosts: ["127.0.0.1"] } });
      try {
        const r = await call("POST", "/api/work/tasks", {
          workspaceId,
          prompt: `steps: ${JSON.stringify([["documents_search", { query: "flights economy" }], ["write", { file_path: "a.md", content: "x" }], ["documents_save", { path: "a.md" }]])}`,
        });
        const asked: string[] = [];
        for (;;) {
          const t = await waitStatus(owner, r.json.id, "completed", "failed", "needs_approval");
          if (t.task.status !== "needs_approval") {
            expect(t.task.status).toBe("completed");
            break;
          }
          const pending = (await call("GET", "/api/work/approvals")).json.filter((a: { taskId: string }) => a.taskId === r.json.id);
          for (const a of pending) {
            asked.push(a.toolName);
            await call("POST", `/api/work/approvals/${a.id}`, { decision: "approve" });
          }
          await waitFor(async () => ((await getTask(owner, r.json.id)).task.status !== "needs_approval" ? true : null));
        }
        // Searching and reading never ask; writing and saving do.
        expect(asked).toEqual(["write", "documents_save"]);
      } finally {
        await db.update(organization).set({ workSettings: { searxngUrl: `${fakeUrl}/searx`, approvals: "risky", browser: hasBrowser, browserAllowedHosts: ["127.0.0.1"] } });
      }
    }, 120_000);
  });

  (hasBrowser ? it : it.skip)("browser: open → click → read → back → choose → fill a form → screenshot → look at it → save notes", async () => {
    const t = await run(workspaceId, [
      ["browser_open", { url: `${fakeUrl}/site/` }],
      ["browser_click", { element: "{{ref:Holiday calendar}}" }],
      ["browser_read", {}],
      ["browser_back", {}],
      ["browser_select", { element: "{{ref:Office}}", option: "Mumbai" }],
      ["browser_type", { element: "{{ref:Find}}", text: "leave policy", submit: true, confirm_submit: true }],
      ["browser_screenshot", {}],
      ["read_image", { file_path: "{{png}}" }],
      ["write", { file_path: "holidays.md", content: "Diwali: 8 November." }],
    ]);
    // Submitting a form asks first (risky mode), so approve it.
    let done = await getTask(owner, t.id);
    expect(done.task.status).toBe("needs_approval");
    while (done.task.status === "needs_approval") {
      for (const a of (await call("GET", "/api/work/approvals")).json.filter((x: { taskId: string }) => x.taskId === t.id)) await call("POST", `/api/work/approvals/${a.id}`, { decision: "approve" });
      done = await waitStatus(owner, t.id, "completed", "failed", "needs_approval");
    }
    const s = summarize(done);
    expect(s.task.status).toBe("completed");
    expect(s.calls).toEqual(["browser_open", "browser_click", "browser_read", "browser_back", "browser_select", "browser_type", "browser_screenshot", "read_image", "write"]);
    expect(s.results[0]).toContain("Acme intranet");
    expect(s.results[1]).toContain("Holidays 2026");
    expect(s.results[2]).toContain("Diwali: 8 November");
    expect(s.results[5]).toContain("Found: leave policy in Mumbai");
    expect(s.results[6]).toMatch(/Saved screenshots\/screenshot-[\w-]+\.png/);
    // A model that can't see images is told so plainly.
    expect(s.results[7]).toMatch(/does not declare image input/);
    expect((await s.files()).some((f) => /^screenshots\/.+\.png$/.test(f))).toBe(true);

    // One that can see gets the screenshot itself.
    await call("PATCH", `/api/admin/models/${modelId}`, { vision: true });
    try {
      const look = await run(workspaceId, [
        ["browser_open", { url: `${fakeUrl}/site/holidays` }],
        ["browser_screenshot", { full_page: true }],
        ["read_image", { file_path: "{{png}}" }],
      ]);
      expect(look.task.status).toBe("completed");
      expect(look.results[2]).not.toMatch(/Error/);
      expect(imagesSeen).toBeGreaterThan(0);
    } finally {
      await call("PATCH", `/api/admin/models/${modelId}`, { vision: false });
    }
  }, 120_000);

  it("connected app: look up → write → add a note (asks first)", async () => {
    const c = await call("POST", "/api/admin/connectors", { name: "crm", displayName: "CRM", url: `${fakeUrl}/mcp`, approveTools: "add_*" });
    expect(c.status).toBe(200);
    try {
      const r = await call("POST", "/api/work/tasks", {
        workspaceId,
        prompt: `steps: ${JSON.stringify([
          ["mcp__crm__find_customer", { name: "Bharat Steel" }],
          ["write", { file_path: "renewal.md", content: "Bharat Steel renews on 1 December (owner Ravi)." }],
          ["mcp__crm__add_note", { text: "Renewal brief written" }],
        ])}`,
      });
      const pending = await waitStatus(owner, r.json.id, "needs_approval", "completed", "failed");
      expect(pending.task.status).toBe("needs_approval");
      const ask = (await call("GET", "/api/work/approvals")).json.filter((a: { taskId: string }) => a.taskId === r.json.id);
      expect(ask.map((a: { toolName: string }) => a.toolName)).toEqual(["mcp__crm__add_note"]);
      await call("POST", `/api/work/approvals/${ask[0].id}`, { decision: "approve" });
      const t = summarize(await waitStatus(owner, r.json.id, "completed", "failed"));
      expect(t.task.status).toBe("completed");
      expect(t.results[0]).toContain("renewal due 1 December");
      expect(t.results[2]).toContain("Note saved: Renewal brief written");
      expect(mcpCalls.map((x) => x.name)).toEqual(["find_customer", "add_note"]);
      expect(await fileOf(t.id, "renewal.md")).toContain("1 December");
    } finally {
      await call("PATCH", `/api/admin/connectors/${c.json.id}`, { enabled: false });
    }
  }, 120_000);

  it("skills: load a skill, then follow it", async () => {
    await call("POST", "/api/work/skills", { name: "Expense report", description: "Use when writing an expense report", body: "Always end the report with the line: Approved by finance.", scope: "org" });
    const t = await run(workspaceId, [
      ["skill", { name: "expense-report" }],
      ["write", { file_path: "expenses.md", content: "Taxi 400\nApproved by finance." }],
    ]);
    expect(t.task.status).toBe("completed");
    expect(t.results[0]).toContain("Approved by finance");
  }, 90_000);

  it("helpers: a subagent does part of the work and reports back", async () => {
    const sub = `steps: ${JSON.stringify([["write", { file_path: "from-helper.txt", content: "helper was here" }]])}`;
    const t = await run(workspaceId, [
      ["subagent", { description: "Write a file", prompt: sub, run_in_background: false }],
      ["list_agents", {}],
      ["read", { file_path: "from-helper.txt" }],
    ]);
    expect(t.task.status).toBe("completed");
    // The helper's own steps show in the task's timeline, after the call that started it.
    expect(t.calls).toEqual(["subagent", "write", "list_agents", "read"]);
    expect(t.results[0]).toContain("Done.");
    expect(t.results[3]).toContain("helper was here");
  }, 120_000);

  it("helpers: a forked helper, a background one the agent messages and stops; the task still ends", async () => {
    const fork = `steps: ${JSON.stringify([["write", { file_path: "from-fork.txt", content: "fork was here" }]])}`;
    const slow = `steps: ${JSON.stringify([["bash", { command: "sleep 60", description: "Wait a minute" }]])}`;
    const started = Date.now();
    const t = await run(workspaceId, [
      ["subagent_fork", { description: "Write a file", prompt: fork }],
      ["subagent", { description: "Slow helper", prompt: slow, run_in_background: true }],
      ["list_agents", {}],
      ["send_message", { agent_id: "{{agent}}", message: "Please hurry." }],
      ["interrupt_agent", { agent_id: "{{agent}}" }],
      ["read", { file_path: "from-fork.txt" }],
    ]);
    expect(t.task.status).toBe("completed");
    // The background helper may or may not have started its command before it was stopped.
    const own = t.calls.map((c, i) => [c, t.results[i]!] as const).filter(([c]) => c !== "bash");
    expect(own.map(([c]) => c)).toEqual(["subagent_fork", "write", "subagent", "list_agents", "send_message", "interrupt_agent", "read"]);
    const out = Object.fromEntries(own.map(([c, r]) => [c, r]));
    expect(out.subagent).toMatch(/^started subagent [\w-]+/);
    expect(out.list_agents).toMatch(/\[running\] — Slow helper/);
    expect(out.send_message).not.toMatch(/unavailable|Error/);
    expect(out.interrupt_agent).toMatch(/^interrupt requested for agent [\w-]+/);
    expect(out.read).toContain("fork was here");
    // An interrupted helper doesn't keep the task open (it used to wait forever).
    expect(Date.now() - started).toBeLessThan(45_000);
  }, 120_000);

  it("background jobs: a slow command moves to the background; read its output, stop another", async () => {
    const t = await run(workspaceId, [
      ["bash", { command: "sleep 2; echo slow-done", description: "Slow command", timeoutMs: 500 }],
      ["job_output", { job_id: "{{job}}", wait: true, timeout_ms: 10_000 }],
      ["bash", { command: "sleep 120", description: "Very slow command", timeoutMs: 300 }],
      ["job_list", {}],
      ["job_kill", { job_id: "{{job}}", reason: "Not needed" }],
      ["job_list", {}],
    ]);
    expect(t.task.status).toBe("completed");
    expect(t.results[0]).toContain("moved to background job bash-1");
    expect(t.results[1]).toMatch(/slow-done[\s\S]*status: completed, exit code: 0/);
    expect(t.results[3]).toMatch(/bash-2 \[bash\] running/);
    expect(t.results[5]).not.toMatch(/bash-2 \[bash\] running/);
  }, 120_000);
});
