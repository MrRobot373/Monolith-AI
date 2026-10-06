/**
 * Runs the real DeepSeek Harness runtime against a fake Aatmiq control server:
 * a scripted OpenAI-compatible model, the approval endpoint and web search.
 */
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDshEngine } from "./dsh/engine";
import { buildPatch } from "./dsh/patch";
import { classifyRisk } from "./policy";
import type { HarnessEvent, TaskSpec } from "./types";

let server: Server;
let controlUrl = "";
const approvals: { toolName: string; reason: string | null }[] = [];
let approvalAnswer: "approved" | "rejected" = "rejected";
const searches: string[] = [];
const seenAuth = new Set<string>();

function sse(res: import("node:http").ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** Scripted model: "run: X" → bash, "search: X" → web_search, then summarize the tool result. */
function fakeModel(body: { messages: { role: string; content: unknown }[] }, res: import("node:http").ServerResponse) {
  const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");
  const last = body.messages.at(-1)!;
  const usage = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } };
  if (last.role === "tool") return sse(res, [{ choices: [{ index: 0, delta: { content: `Result: ${text(last.content).trim().slice(0, 200)}` } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  const ask = text([...body.messages].reverse().find((m) => m.role === "user" && !/^Current runtime context/.test(text(m.content)))?.content);
  let call: [string, unknown] | null = null;
  let m: RegExpExecArray | null;
  if ((m = /run: (.+)/s.exec(ask))) call = ["bash", { description: "Run it", command: m[1]!.trim() }];
  else if ((m = /search: (.+)/.exec(ask))) call = ["web_search", { queries: [m[1]!.trim()] }];
  if (!call) return sse(res, [{ choices: [{ index: 0, delta: { content: "Hello from the fake model." } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  return sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    usage,
  ]);
}

beforeAll(async () => {
  let approvalId = 0;
  server = createServer(async (req, res) => {
    seenAuth.add(String(req.headers.authorization));
    let raw = "";
    for await (const c of req) raw += c;
    const json = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const url = req.url ?? "";
    if (url === "/llm/v1/chat/completions") return fakeModel(JSON.parse(raw), res);
    if (url === "/approvals" && req.method === "POST") {
      const b = JSON.parse(raw);
      approvals.push({ toolName: b.toolName, reason: b.reason });
      return json(200, { id: String(++approvalId) });
    }
    if (url.startsWith("/approvals/")) return json(200, { status: approvalAnswer });
    if (url === "/search") {
      searches.push(JSON.parse(raw).query);
      return json(200, { sources: [{ url: "https://intranet.example/policy", title: "Travel policy", snippet: "Economy class for flights under 6 hours." }] });
    }
    json(404, { error: "not found" });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  controlUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

async function spec(): Promise<TaskSpec> {
  const root = await mkdtemp(join(tmpdir(), "aatmiq-harness-"));
  return {
    taskId: "task-1",
    workdir: join(root, "work"),
    homeDir: join(root, "home"),
    model: { key: "fake-model", name: "Fake", contextWindow: 32768 },
    controlUrl,
    token: "task-secret-token",
    approvals: "risky",
    askForNetwork: true,
    webSearch: true,
    skillsDir: null,
    connectors: [],
    productName: "Aatmiq",
  };
}

/** Run one prompt to the end of its turn and return the events. */
async function runTurn(text: string, s?: TaskSpec) {
  const events: HarnessEvent[] = [];
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const theSpec = s ?? (await spec());
  const rt = await createDshEngine().start(theSpec, (e) => {
    events.push(e);
    if (e.type === "turn_end") done();
  });
  await rt.send(text);
  await Promise.race([finished, new Promise((r) => setTimeout(r, 30_000))]);
  await rt.stop();
  return { events, spec: theSpec };
}

describe("risk policy", () => {
  const p = { approvals: "risky" as const, askForNetwork: true, connectors: [{ name: "github", approveTools: ["create_*", "merge_*"] }] };
  it("asks before destructive, privileged and network commands", () => {
    expect(classifyRisk({ name: "bash", args: { command: "rm -rf build" } }, p)).toBe("Deletes files");
    expect(classifyRisk({ name: "bash", args: { command: "git push origin main" } }, p)).toContain("git");
    expect(classifyRisk({ name: "bash", args: { command: "curl https://x.test" } }, p)).toBe("Uses the network");
    expect(classifyRisk({ name: "bash", args: { command: "pip install pandas" } }, p)).toContain("packages");
    expect(classifyRisk({ name: "bash", args: { command: "ls -la && cat notes.md | grep rm" } }, p)).toBeNull();
    expect(classifyRisk({ name: "bash", args: { command: "curl https://x.test" } }, { ...p, askForNetwork: false })).toBeNull();
    expect(classifyRisk({ name: "write", args: {} }, p)).toBeNull();
  });
  it("follows connector rules and the always/never modes", () => {
    expect(classifyRisk({ name: "mcp__github__create_issue", args: {} }, p)).toContain("github");
    expect(classifyRisk({ name: "mcp__github__list_issues", args: {} }, p)).toBeNull();
    expect(classifyRisk({ name: "write", args: {} }, { ...p, approvals: "always" })).toBeTruthy();
    expect(classifyRisk({ name: "bash", args: { command: "rm x" } }, { ...p, approvals: "never" })).toBeNull();
  });
});

describe("patch", () => {
  it("routes models through Aatmiq and switches off third-party clouds", async () => {
    const y = buildPatch(await spec());
    expect(y).toContain("baseURL: http://127.0.0.1");
    expect(y).toContain("apiKeyEnv: AATMIQ_TOKEN");
    expect(y).toMatch(/- id: deepseek-account\n {2}disabled: true/);
    expect(y).toMatch(/- id: web-search-deepseek\n {2}disabled: true/);
    expect(y).toContain("searchProvider: aatmiq");
    expect(y).not.toContain("task-secret-token");
  });
});

describe("DeepSeek Harness engine", () => {
  it("runs a command in the task folder and reports each step", async () => {
    const { events, spec: s } = await runTurn("run: echo hello-aatmiq > note.txt && cat note.txt");
    const call = events.find((e) => e.type === "tool_call");
    expect(call).toMatchObject({ name: "bash" });
    const result = events.find((e) => e.type === "tool_result");
    expect(result).toMatchObject({ isError: false });
    expect((result as { text: string }).text).toContain("hello-aatmiq");
    expect(await readFile(join(s.workdir, "note.txt"), "utf8")).toContain("hello-aatmiq");
    const answer = events.filter((e) => e.type === "assistant").at(-1) as { text: string; usage?: { inputTokens: number } };
    expect(answer.text).toContain("hello-aatmiq");
    expect(answer.usage?.inputTokens).toBe(50);
    expect(events.some((e) => e.type === "user")).toBe(true);
    expect(seenAuth.has("Bearer task-secret-token")).toBe(true);
  }, 60_000);

  it("asks before deleting; a rejection keeps the file", async () => {
    const s = await spec();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(s.workdir, { recursive: true });
    await writeFile(join(s.workdir, "keep.txt"), "important");
    approvalAnswer = "rejected";
    const { events } = await runTurn("run: rm keep.txt", s);
    expect(approvals.at(-1)).toMatchObject({ toolName: "bash", reason: "Deletes files" });
    expect(events.find((e) => e.type === "tool_result")).toMatchObject({ isError: true });
    expect(existsSync(join(s.workdir, "keep.txt"))).toBe(true);
    approvalAnswer = "approved";
    await runTurn("run: rm keep.txt", s);
    expect(existsSync(join(s.workdir, "keep.txt"))).toBe(false);
  }, 90_000);

  it("confines commands: writes outside the task folder (and /tmp) fail", async () => {
    const s = await spec();
    const { mkdtemp: mk, rm } = await import("node:fs/promises");
    const elsewhere = await mk(join(process.cwd(), ".sandbox-test-"));
    const outside = join(elsewhere, "escape.txt");
    try {
      const { events } = await runTurn(`run: echo nope > ${outside}`, s);
      const result = events.find((e) => e.type === "tool_result") as { text: string };
      expect(result.text).toMatch(/denied|read-only|not permitted|exit code: [1-9]/i);
      expect(existsSync(outside)).toBe(false);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  }, 60_000);

  it.runIf(process.getuid?.() === 0)("runs as the task's own user, which can't read private server files", async () => {
    const { mkdtemp: mk, rm, chmod } = await import("node:fs/promises");
    const secretDir = await mk(join(tmpdir(), "aatmiq-private-"));
    await writeFile(join(secretDir, "secret.txt"), "top-secret");
    await chmod(secretDir, 0o700);
    const base = await spec();
    const root = join(base.workdir, "..");
    await chmod(root, 0o711);
    try {
      const { events } = await runTurn(`run: id -u; cat ${secretDir}/secret.txt`, { ...base, uid: 100_123, gid: 100_123 });
      const result = events.find((e) => e.type === "tool_result") as { text: string };
      expect(result.text).toContain("100123");
      expect(result.text).not.toContain("top-secret");
      expect(result.text).toMatch(/permission denied/i);
    } finally {
      await rm(secretDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("searches the web through Aatmiq", async () => {
    const { events } = await runTurn("search: travel policy flights");
    expect(searches).toContain("travel policy flights");
    const result = events.find((e) => e.type === "tool_result") as { text: string };
    expect(result.text).toContain("intranet.example/policy");
  }, 60_000);
});
