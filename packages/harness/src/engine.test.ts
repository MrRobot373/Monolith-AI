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
import { APPROVAL_PRESETS } from "@aatmiq/shared";
import { classifyRisk } from "./policy";
import { containerArgs, containerEnv, egressToken, type ContainerOptions } from "./dsh/container";
import { cleanArgs, planReminder, stripReminders } from "../dsh-plugin/tooling.mjs";
import type { HarnessEvent, TaskSpec } from "./types";

let server: Server;
let controlUrl = "";
const approvals: { toolName: string; reason: string | null }[] = [];
let approvalAnswer: "approved" | "rejected" = "rejected";
const searches: string[] = [];
const browserCalls: Record<string, unknown>[] = [];
const seenAuth = new Set<string>();
const toolMessages: string[] = [];

function sse(res: import("node:http").ServerResponse, chunks: unknown[]) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  res.end("data: [DONE]\n\n");
}

/**
 * Scripted model: "run: X" → bash, "search: X" → web_search, then summarize the tool result.
 * "script: [[tool, args], …]" makes those calls one after another, then says "Done.".
 */
function fakeModel(body: { messages: { role: string; content: unknown }[] }, res: import("node:http").ServerResponse) {
  const text = (c: unknown) => (typeof c === "string" ? c : Array.isArray(c) ? c.map((p: { text?: string }) => p.text ?? "").join("") : "");
  const last = body.messages.at(-1)!;
  const usage = { choices: [], usage: { prompt_tokens: 50, completion_tokens: 10 } };
  const askAt = body.messages.findLastIndex((m) => m.role === "user" && !/^Current runtime context/.test(text(m.content)));
  const ask = text(body.messages[askAt]?.content);
  if (last.role === "tool") toolMessages.push(text(last.content));
  const script = /^script: (.+)/s.exec(ask);
  let call: [string, unknown] | null = null;
  if (script) {
    const steps = JSON.parse(script[1]!) as [string, unknown][];
    call = steps[body.messages.slice(askAt).filter((m) => m.role === "tool").length] ?? null;
    if (!call) return sse(res, [{ choices: [{ index: 0, delta: { content: "Done." } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  } else if (last.role === "tool") {
    return sse(res, [{ choices: [{ index: 0, delta: { content: `Result: ${text(last.content).trim().slice(0, 200)}` } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  }
  let m: RegExpExecArray | null;
  if (call) {
    /* scripted */
  } else if ((m = /run: (.+)/s.exec(ask))) call = ["bash", { description: "Run it", command: m[1]!.trim() }];
  else if ((m = /search: (.+)/.exec(ask))) call = ["web_search", { queries: [m[1]!.trim()] }];
  if (!call) return sse(res, [{ choices: [{ index: 0, delta: { content: "Hello from the fake model." } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }, usage]);
  return sse(res, [
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, type: "function", function: { name: call[0], arguments: JSON.stringify(call[1]) } }] } }] },
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
    if (url === "/browser") {
      const b = JSON.parse(raw) as { action: string; ref?: number; confirmSubmit?: boolean };
      browserCalls.push(b);
      // Element 2 is a submit button: held until confirmed, like Aatmiq's browser.
      if (b.action === "click" && b.ref === 2 && !b.confirmSubmit) return json(422, { error: "[2] submits a form. If that's what the task needs, call browser_click again with confirm_submit: true." });
      if (b.action === "screenshot") return json(200, { file: "screenshots/shop.png", url: "https://shop.example/", title: "Shop" });
      return json(200, { url: "https://shop.example/", title: "Shop", text: '[1] textbox "Search"\n[2] button "Order"', truncated: false, downloads: [] });
    }
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
  it("browser: reading never asks; a confirmed form submission does; under always every action does", () => {
    expect(classifyRisk({ name: "browser_open", args: { url: "https://x.test" } }, p)).toBeNull();
    expect(classifyRisk({ name: "browser_click", args: { element: 3 } }, p)).toBeNull();
    expect(classifyRisk({ name: "browser_click", args: { element: 3, confirm_submit: true } }, p)).toBe("Submits a form on a website");
    expect(classifyRisk({ name: "browser_type", args: { element: 1, text: "x", submit: true, confirm_submit: true } }, p)).toBe("Submits a form on a website");
    const always = { ...p, approvals: "always" as const };
    expect(classifyRisk({ name: "browser_open", args: {} }, always)).toContain("Every action");
    expect(classifyRisk({ name: "browser_read", args: {} }, always)).toBeNull();
    expect(classifyRisk({ name: "browser_click", args: { confirm_submit: true } }, { ...p, approvals: "never" })).toBeNull();
  });

  it("follows connector rules and the always/never modes", () => {
    expect(classifyRisk({ name: "mcp__github__create_issue", args: {} }, p)).toContain("github");
    expect(classifyRisk({ name: "mcp__github__list_issues", args: {} }, p)).toBeNull();
    const changes = { ...p, connectors: [{ name: "gmail", approveTools: APPROVAL_PRESETS.changes.split(",") }] };
    expect(classifyRisk({ name: "mcp__gmail__search_threads", args: {} }, changes)).toBeNull();
    expect(classifyRisk({ name: "mcp__gmail__get_message", args: {} }, changes)).toBeNull();
    expect(classifyRisk({ name: "mcp__gmail__create_draft", args: {} }, changes)).toContain("gmail");
    expect(classifyRisk({ name: "mcp__gmail__send", args: {} }, changes)).toContain("gmail");
    expect(classifyRisk({ name: "write", args: {} }, { ...p, approvals: "always" })).toBeTruthy();
    expect(classifyRisk({ name: "bash", args: { command: "rm x" } }, { ...p, approvals: "never" })).toBeNull();
  });
});

describe("tool-call cleanup", () => {
  it("drops sandbox_permissions that ask for nothing, keeps a real escalation", () => {
    const mode = "workspace-write";
    expect(cleanArgs("bash", { command: "ls", sandbox_permissions: "workspace-write" }, mode)).toEqual({ command: "ls" });
    expect(cleanArgs("write", { file_path: "a", content: "x", sandbox_permissions: "read,write", justification: "save" }, mode)).toEqual({ file_path: "a", content: "x" });
    expect(cleanArgs("bash", { command: "ls", sandbox_permissions: "danger-full-access" }, mode)).toEqual({ command: "ls" }); // no justification
    expect(cleanArgs("bash", { command: "ls", justification: "List files" }, mode)).toEqual({ command: "ls" }); // justification alone
    const escalate = { command: "pip install --user x", sandbox_permissions: "danger-full-access", justification: "Install the library." };
    expect(cleanArgs("bash", escalate, mode)).toBe(escalate);
    const plain = { command: "ls" };
    expect(cleanArgs("bash", plain, mode)).toBe(plain);
  });
  it("reads an empty search path as the working folder", () => {
    expect(cleanArgs("glob", { path: "", pattern: "**/*" }, "workspace-write")).toEqual({ pattern: "**/*" });
    expect(cleanArgs("grep", { path: " ", pattern: "x", include: "*.html" }, "workspace-write")).toEqual({ pattern: "x", include: "*.html" });
    expect(cleanArgs("read", { path: "" }, "workspace-write")).toEqual({ path: "" });
  });
  it("fixes todo_write items: task → content, missing or loose status, extra fields, a JSON string", () => {
    expect(cleanArgs("todo_write", { todos: [{ task: "Write CSS" }, { content: "Write JS", status: "Done" }, { title: "Test", status: "in-progress", id: 3 }] }, "workspace-write")).toEqual({
      todos: [
        { content: "Write CSS", status: "pending" },
        { content: "Write JS", status: "completed" },
        { content: "Test", status: "in_progress" },
      ],
    });
    expect(cleanArgs("todo_write", { todos: JSON.stringify([{ content: "A", status: "pending" }]) }, "workspace-write")).toEqual({ todos: [{ content: "A", status: "pending" }] });
  });
  it("reminds after a few steps without a plan update, and only while steps are open", () => {
    const todos = [
      { content: "Write CSS", status: "completed" },
      { content: "Write JS", status: "in_progress" },
      { content: "Test", status: "pending" },
    ];
    expect(planReminder(todos, 2)).toBeNull();
    expect(planReminder(todos, 3)).toContain('1 of 3 done, current step "Write JS"');
    expect(planReminder(todos, 4)).toBeNull();
    expect(planReminder(todos, 7)).not.toBeNull();
    expect(planReminder(todos.map((t) => ({ ...t, status: "completed" })), 3)).toBeNull();
    expect(stripReminders(`ok\n\n${planReminder(todos, 3)}`)).toBe("ok");
  });
});

describe("container mode", () => {
  const opts: ContainerOptions = {
    image: "aatmiq-api:1.2",
    network: "aatmiq_tasks",
    volume: { name: "aatmiq_files", root: "/data" },
    proxyUrl: "http://aatmiq-api:3128",
    noProxy: ["aatmiq-api"],
    limits: { cpus: 2, memoryMb: 4096, pidsLimit: 1024, network: "proxy" },
  };
  const spec = {
    taskId: "t-123",
    workdir: "/data/work/t-123/files",
    homeDir: "/data/work/t-123/runtime",
    uid: 100042,
    token: "secret-token-value",
    container: { cpus: 1.5, memoryMb: 2048, pidsLimit: 512, network: "proxy" as const },
  } as unknown as TaskSpec;
  const env = { AATMIQ_TOKEN: "secret-token-value", HOME: "/data/work/t-123/runtime", HTTPS_PROXY: "http://corp:8080" };

  it("mounts only the task folder from the volume, with the task's user, limits and no privileges", () => {
    const args = containerArgs(opts, { cli: "/opt/dsh/bin.js", argv: ["--profile", "sdk"], cwd: spec.workdir, env, spec });
    const joined = args.join(" ");
    expect(args.slice(0, 4)).toEqual(["run", "-i", "--rm", "--init"]);
    expect(joined).toContain("--mount type=volume,src=aatmiq_files,dst=/data/work/t-123,volume-subpath=work/t-123");
    expect(joined).toContain("--tmpfs /data:rw,noexec,nosuid,nodev,size=1m,mode=755");
    expect(joined).toContain("--user 100042:100042");
    expect(joined).toContain("--network aatmiq_tasks");
    expect(joined).toContain("--cpus 1.5 --memory 2048m --memory-swap 2048m --pids-limit 512");
    expect(joined).toContain("--cap-drop ALL --security-opt no-new-privileges --read-only");
    expect(joined).toContain("--name aatmiq-task-t-123 --label aatmiq.task=t-123");
    expect(args.slice(-6)).toEqual(["--entrypoint", "node", "aatmiq-api:1.2", "/opt/dsh/bin.js", "--profile", "sdk"]);
    // Values never reach the command line; the CLI reads them from its environment.
    expect(joined).not.toContain("secret-token-value");
    expect(joined).toContain("--env AATMIQ_TOKEN");
  });

  it("binds the same path without a volume, and refuses a folder outside the volume", () => {
    expect(containerArgs({ ...opts, volume: null }, { cli: "c", argv: [], cwd: spec.workdir, env: {}, spec }).join(" ")).toContain("--mount type=bind,src=/data/work/t-123,dst=/data/work/t-123");
    expect(() => containerArgs({ ...opts, volume: { name: "v", root: "/srv" } }, { cli: "c", argv: [], cwd: spec.workdir, env: {}, spec })).toThrow("isn't inside the volume root");
  });

  it("internet only through Aatmiq's proxy with a credential from the task's token (Aatmiq itself direct), or none", () => {
    const e = containerEnv(opts, env, spec);
    const cred = egressToken("secret-token-value");
    expect(cred).toMatch(/^[0-9a-f]{64}$/);
    expect(e.HTTPS_PROXY).toBe(`http://task:${cred}@aatmiq-api:3128`);
    expect(e.http_proxy).toBe(`http://task:${cred}@aatmiq-api:3128`);
    expect(e.NO_PROXY).toBe("localhost,127.0.0.1,aatmiq-api");
    expect(e.AATMIQ_TOKEN).toBe("secret-token-value");
    const none = containerEnv(opts, env, { ...spec, container: { ...spec.container!, network: "none" } } as TaskSpec);
    expect(none.HTTPS_PROXY).toBeUndefined();
    expect(none.https_proxy).toBeUndefined();
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

  it("runs calls with stray sandbox_permissions and misnamed plan fields instead of failing them", async () => {
    const script = [
      ["todo_write", { todos: [{ task: "Write the note" }, { task: "Check it", status: "todo" }] }],
      ["write", { file_path: "note.txt", content: "hello", sandbox_permissions: "read,write" }],
      ["bash", { description: "Show it", command: "cat note.txt", sandbox_permissions: "workspace-write", justification: "Read the note" }],
      ["glob", { path: "", pattern: "*.txt" }],
    ];
    const { events, spec: s } = await runTurn(`script: ${JSON.stringify(script)}`);
    const results = events.filter((e) => e.type === "tool_result") as { isError: boolean; text: string }[];
    expect(results.map((r) => r.isError)).toEqual([false, false, false, false]);
    expect(results[2]!.text).toContain("hello");
    expect(results[3]!.text).toContain("note.txt");
    expect(await readFile(join(s.workdir, "note.txt"), "utf8")).toBe("hello");
    const plans = events.filter((e) => e.type === "plan") as { items: { content: string; status: string }[] }[];
    expect(plans[0]!.items).toEqual([
      { content: "Write the note", status: "pending" },
      { content: "Check it", status: "pending" },
    ]);
  }, 60_000);

  it("reminds the agent to update a stale plan, out of sight of the person", async () => {
    const script = [
      ["todo_write", { todos: [{ content: "One", status: "in_progress" }, { content: "Two", status: "pending" }] }],
      ["bash", { description: "Step", command: "echo step-1" }],
      ["bash", { description: "Step", command: "echo step-2" }],
      ["bash", { description: "Step", command: "echo step-3" }],
    ];
    toolMessages.length = 0;
    const { events } = await runTurn(`script: ${JSON.stringify(script)}`);
    expect(toolMessages.filter((t) => t.includes("<plan-reminder>"))).toHaveLength(1);
    expect(toolMessages.at(-1)).toContain('0 of 2 done, current step "One"');
    const results = events.filter((e) => e.type === "tool_result") as { text: string }[];
    expect(results.at(-1)!.text).toContain("step-3");
    expect(results.some((r) => r.text.includes("plan-reminder"))).toBe(false);
  }, 60_000);

  it("keeps the task open while a background subagent works, without mixing in its messages", async () => {
    const script = [["subagent", { description: "Count", prompt: "run: echo from-the-subagent", run_in_background: true }]];
    const { events } = await runTurn(`script: ${JSON.stringify(script)}`);
    const ends = events.filter((e) => e.type === "turn_end");
    expect(ends).toHaveLength(1);
    const endAt = events.indexOf(ends[0]!);
    // The subagent's command shows as a step, before the task's single turn end.
    const subResult = events.findIndex((e) => e.type === "tool_result" && e.text.includes("from-the-subagent"));
    expect(subResult).toBeGreaterThan(-1);
    expect(subResult).toBeLessThan(endAt);
    // Its own answer isn't the task's answer.
    expect(events.filter((e) => e.type === "assistant").some((e) => (e as { text: string }).text.startsWith("Result: from-the-subagent"))).toBe(false);
  }, 90_000);

  it("browses through Aatmiq: page views, a held form submission, approval, screenshot", async () => {
    approvalAnswer = "approved";
    approvals.length = 0;
    const steps = [
      ["browser_open", { url: "https://shop.example" }],
      ["browser_type", { element: 1, text: "socks", submit: true }],
      ["browser_click", { element: 2 }],
      ["browser_click", { element: 2, confirm_submit: true }],
      ["browser_screenshot", {}],
    ];
    const s = { ...(await spec()), browser: true };
    const { events } = await runTurn(`script: ${JSON.stringify(steps)}`, s);
    expect(browserCalls.map((c) => c.action)).toEqual(["open", "type", "click", "click", "screenshot"]);
    expect(browserCalls[1]).toMatchObject({ ref: 1, text: "socks", submit: true, confirmSubmit: false });
    const results = events.filter((e) => e.type === "tool_result") as { text: string; isError: boolean }[];
    expect(results[0]!.text).toContain("Page: Shop");
    expect(results[0]!.text).toContain('[2] button "Order"');
    expect(results[2]).toMatchObject({ isError: true });
    expect(results[2]!.text).toContain("confirm_submit: true");
    expect(results[4]!.text).toContain("Saved screenshots/shop.png");
    // Only the confirmed submission asked the person.
    expect(approvals).toEqual([{ toolName: "browser_click", reason: "Submits a form on a website" }]);
  }, 60_000);

  it("has no browser tools when the organization turns the browser off", async () => {
    browserCalls.length = 0;
    const { events } = await runTurn(`script: ${JSON.stringify([["browser_open", { url: "https://shop.example" }]])}`);
    expect(browserCalls).toEqual([]);
    const r = events.find((e) => e.type === "tool_result") as { text: string; isError: boolean };
    expect(r.isError).toBe(true);
  }, 60_000);

  it("searches the web through Aatmiq", async () => {
    const { events } = await runTurn("search: travel policy flights");
    expect(searches).toContain("travel policy flights");
    const result = events.find((e) => e.type === "tool_result") as { text: string };
    expect(result.text).toContain("intranet.example/policy");
  }, 60_000);
});
