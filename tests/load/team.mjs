/**
 * A team's day, compressed: N people (default 25) using Aatmiq at once for a few minutes, against a
 * running stack (started by run-team.sh). Each person chats, starts agent tasks and opens pages
 * with short pauses in between; some keep the Code editor open in a real browser. Measures what
 * people feel (time to the first word of an answer, how long agent tasks wait for a slot, page
 * API times, errors) and what the server uses (memory per agent task and per editor).
 *
 *   USERS=25 MINUTES=5 CODE_USERS=5 tests/load/run-team.sh
 *
 * The model is the fake one, paced like a GPU (FAKE_LLM_FIRST_MS, FAKE_LLM_WORD_MS), so this
 * measures Aatmiq itself, not the model server.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

// Playwright comes from the browser suites' own install (tests/e2e).
const { chromium } = createRequire(new URL("../e2e/package.json", import.meta.url))("playwright-core");

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const FAKE = "http://localhost:11500";
const USERS = Number(process.env.USERS ?? 25);
const MINUTES = Number(process.env.MINUTES ?? 5);
const CODE_USERS = Number(process.env.CODE_USERS ?? 5);
const MAX_RUNNING = Number(process.env.MAX_RUNNING ?? 8);
const OUT = new URL("./results/", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

/* ───────────── HTTP with a cookie per person ───────────── */

class Person {
  constructor(name) {
    this.name = name;
    this.cookie = "";
  }
  async fetch(method, path, body, raw = false) {
    const res = await fetch(`${APP}${path}`, {
      method,
      headers: { origin: APP, ...(this.cookie ? { cookie: this.cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) this.cookie = set.map((c) => c.split(";")[0]).join("; ");
    if (raw) return res;
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json?.error ?? text.slice(0, 100)}`);
    return json;
  }
}

/* ───────────── Measurements ───────────── */

const m = { chatFirst: [], chatTotal: [], taskWait: [], taskTotal: [], page: [], errors: [], chats: 0, tasks: 0, pages: 0 };
const time = async (list, fn) => {
  const t = performance.now();
  const r = await fn();
  list.push(performance.now() - t);
  return r;
};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => (x === null ? "–" : x >= 10_000 ? `${(x / 1000).toFixed(1)} s` : `${Math.round(x)} ms`);

/** Memory (MB) of the processes that matter, from ps. */
function memory() {
  const out = execFileSync("ps", ["-eo", "rss=,args="], { encoding: "utf8" });
  const sum = { api: 0, tasks: 0, taskCount: 0, ides: 0, ideProcs: 0 };
  for (const line of out.split("\n")) {
    const mt = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!mt) continue;
    const kb = Number(mt[1]);
    const args = mt[2];
    if (args.includes("--profile sdk")) {
      sum.tasks += kb;
      sum.taskCount++;
    } else if (/aatmiq-code|server-main\.js|extensionHost|bootstrap-fork/.test(args)) {
      sum.ides += kb;
      sum.ideProcs++;
    } else if (/src\/server\.ts|dist\/server\.js/.test(args)) sum.api += kb;
  }
  const free = execFileSync("free", ["-m"], { encoding: "utf8" }).split("\n")[1].split(/\s+/);
  return { apiMb: sum.api / 1024, tasksMb: sum.tasks / 1024, taskCount: sum.taskCount, idesMb: sum.ides / 1024, ideProcs: sum.ideProcs, usedMb: Number(free[2]) };
}

/* ───────────── Setup ───────────── */

const owner = new Person("owner");
await owner.fetch("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
const ws = (await owner.fetch("GET", "/api/me")).workspaces[0].id;
const provider = await owner.fetch("POST", "/api/admin/providers", { name: "GPU server", type: "openai_compatible", baseUrl: `${FAKE}/v1` });
const model = await owner.fetch("POST", "/api/admin/models", { providerId: provider.id, modelKey: "qwen3:8b", displayName: "Main model", sections: ["chat", "work", "code"], contextLength: 65536 });
await owner.fetch("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: [model.id], defaultModelId: model.id });
await owner.fetch("PUT", "/api/admin/work", { maxRunning: MAX_RUNNING, maxConcurrentPerUser: 2 });

const people = [owner];
for (let i = 1; i < USERS; i++) {
  const p = new Person(`user${i}`);
  const inv = await owner.fetch("POST", "/api/admin/invites", { email: `user${i}@acme.test`, workspaces: [{ workspaceId: ws, role: "member" }] });
  await p.fetch("POST", `/api/invites/${inv.link.split("/invite/")[1]}/accept`, { name: `User ${i}`, password: "a-good-password-1" });
  people.push(p);
}
// Members get Work AI and Code as well.
for (const mem of (await owner.fetch("GET", `/api/admin/workspaces/${ws}/members`)) ?? []) {
  if (mem.role !== "admin") await owner.fetch("PATCH", `/api/admin/workspaces/${ws}/members/${mem.userId}`, { sections: ["chat", "work", "code"] }).catch(() => {});
}
console.log(`${people.length} people signed in`);

/* ───────────── Code editors in real browsers ───────────── */

const browser = CODE_USERS ? await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" }) : null;
const before = memory();
for (const p of people.slice(0, CODE_USERS)) {
  const w = await p.fetch("POST", "/api/code/workspaces", { workspaceId: ws, name: `${p.name} service` });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await ctx.addCookies(p.cookie.split("; ").map((c) => ({ name: c.split("=")[0], value: c.slice(c.indexOf("=") + 1), url: APP })));
  const page = await ctx.newPage();
  await page.goto(`${APP}/app/code/${w.id}`);
  await page.frameLocator('[data-testid="ide-frame"]').locator(".monaco-workbench").waitFor({ timeout: 120_000 });
}
await sleep(5000);
const withIdes = memory();
const perIde = CODE_USERS ? (withIdes.idesMb - before.idesMb) / CODE_USERS : null;
console.log(`${CODE_USERS} editors open: ${perIde?.toFixed(0)} MB each on the server`);

/* ───────────── The busy minutes ───────────── */

const PROMPTS = ["Summarize our travel policy in three bullets.", "Draft a polite reply to a customer asking for a refund.", "Explain this error: ECONNREFUSED.", "Write three short paragraphs about the sea."];
const TASKS = ["run: python3 -c \"print(sum(range(10**6)))\" > result.txt && cat result.txt", "run: for i in 1 2 3; do echo line $i; done > notes.md && wc -l notes.md", "write report.md: # Weekly report\n\nAll good."];

async function chat(p) {
  const c = await p.fetch("POST", "/api/chats", { workspaceId: ws });
  const t0 = performance.now();
  const res = await p.fetch("POST", `/api/chats/${c.id}/messages`, { content: PROMPTS[Math.floor(Math.random() * PROMPTS.length)] }, true);
  if (!res.ok) throw new Error(`chat → ${res.status} ${(await res.text()).slice(0, 120)}`);
  let first = null;
  let buf = "";
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString();
    if (first === null && buf.includes("event: delta")) first = performance.now() - t0;
    if (buf.includes("event: error")) throw new Error(`chat error: ${buf.slice(buf.indexOf("event: error"), buf.indexOf("event: error") + 160)}`);
  }
  if (!buf.includes("event: done")) throw new Error("chat ended without an answer");
  m.chatFirst.push(first ?? performance.now() - t0);
  m.chatTotal.push(performance.now() - t0);
  m.chats++;
}

async function task(p) {
  const t0 = performance.now();
  const t = await p.fetch("POST", "/api/work/tasks", { workspaceId: ws, prompt: TASKS[Math.floor(Math.random() * TASKS.length)] });
  let started = null;
  for (;;) {
    await sleep(500);
    const d = await p.fetch("GET", `/api/work/tasks/${t.id}`);
    if (started === null && d.task.status !== "queued") started = performance.now() - t0;
    if (d.task.status === "completed") break;
    if (["failed", "cancelled"].includes(d.task.status)) throw new Error(`task ${d.task.status}: ${d.task.error}`);
    if (performance.now() - t0 > 10 * 60_000) throw new Error("task took over 10 minutes");
  }
  m.taskWait.push(started ?? 0);
  m.taskTotal.push(performance.now() - t0);
  m.tasks++;
}

async function pages(p) {
  for (const path of ["/api/me", `/api/chats?workspaceId=${ws}`, `/api/work/tasks?workspaceId=${ws}`, `/api/projects?workspaceId=${ws}`, `/api/workspaces/${ws}/models?section=chat`]) await time(m.page, () => p.fetch("GET", path));
  m.pages++;
}

const samples = [];
const sampler = setInterval(() => samples.push({ t: Date.now(), ...memory() }), 3000);
await fetch(`${FAKE}/stats/reset`);
const end = Date.now() + MINUTES * 60_000;
await Promise.all(
  people.map(async (p, i) => {
    await sleep(i * 300);
    while (Date.now() < end) {
      const r = Math.random();
      try {
        if (r < 0.6) await chat(p);
        else if (r < 0.8) await task(p);
        else await pages(p);
      } catch (e) {
        m.errors.push(`${p.name}: ${e.message}`);
      }
      // Someone working hard: something new every 5–15 seconds.
      await sleep(rand(5000, 15000));
    }
  }),
);
clearInterval(sampler);
const modelStats = await (await fetch(`${FAKE}/stats`)).json();
await browser?.close();

/* ───────────── Report ───────────── */

const peak = (k) => Math.max(...samples.map((s) => s[k]));
const perTask = samples.filter((s) => s.taskCount > 0).map((s) => s.tasksMb / s.taskCount);
const result = {
  users: USERS,
  minutes: MINUTES,
  codeUsers: CODE_USERS,
  maxRunning: MAX_RUNNING,
  chats: m.chats,
  tasks: m.tasks,
  pageLoads: m.pages,
  errors: m.errors,
  chatFirstWord: { p50: pct(m.chatFirst, 50), p95: pct(m.chatFirst, 95), max: pct(m.chatFirst, 100) },
  chatWhole: { p50: pct(m.chatTotal, 50), p95: pct(m.chatTotal, 95) },
  taskWaitForSlot: { p50: pct(m.taskWait, 50), p95: pct(m.taskWait, 95), max: pct(m.taskWait, 100) },
  taskWhole: { p50: pct(m.taskTotal, 50), p95: pct(m.taskTotal, 95) },
  pageApi: { p50: pct(m.page, 50), p95: pct(m.page, 95), max: pct(m.page, 100) },
  model: { requests: modelStats.requests, mostAtOnce: modelStats.maxInflight },
  memory: {
    apiPeakMb: Math.round(peak("apiMb")),
    agentRuntimesPeak: peak("taskCount"),
    agentRuntimesPeakMb: Math.round(peak("tasksMb")),
    perAgentRuntimeMb: perTask.length ? Math.round(perTask.reduce((a, b) => a + b, 0) / perTask.length) : null,
    perEditorMb: perIde === null ? null : Math.round(perIde),
    machineUsedPeakMb: peak("usedMb"),
  },
};
writeFileSync(`${OUT}team-${USERS}.json`, JSON.stringify(result, null, 2));
const lines = [
  `# ${USERS} people for ${MINUTES} minutes (${CODE_USERS} with the editor open, ${MAX_RUNNING} agent tasks at once)`,
  "",
  `${m.chats} chat answers, ${m.tasks} agent tasks, ${m.pages} page loads, **${m.errors.length} errors**.`,
  "",
  "| | p50 | p95 | max |",
  "|---|---|---|---|",
  `| Chat: first word | ${ms(result.chatFirstWord.p50)} | ${ms(result.chatFirstWord.p95)} | ${ms(result.chatFirstWord.max)} |`,
  `| Chat: whole answer | ${ms(result.chatWhole.p50)} | ${ms(result.chatWhole.p95)} | |`,
  `| Agent task: wait for a slot | ${ms(result.taskWaitForSlot.p50)} | ${ms(result.taskWaitForSlot.p95)} | ${ms(result.taskWaitForSlot.max)} |`,
  `| Agent task: start to finish | ${ms(result.taskWhole.p50)} | ${ms(result.taskWhole.p95)} | |`,
  `| Page data (API) | ${ms(result.pageApi.p50)} | ${ms(result.pageApi.p95)} | ${ms(result.pageApi.max)} |`,
  "",
  `Model server: ${modelStats.requests} requests, at most ${modelStats.maxInflight} at once.`,
  "",
  `Memory: API ${result.memory.apiPeakMb} MB at peak; ${result.memory.agentRuntimesPeak} agent runtimes at once (${result.memory.agentRuntimesPeakMb} MB, about ${result.memory.perAgentRuntimeMb} MB each); each open editor about ${result.memory.perEditorMb} MB; the whole machine at most ${result.memory.machineUsedPeakMb} MB.`,
  ...(m.errors.length ? ["", "Errors:", ...m.errors.slice(0, 20).map((e) => `- ${e}`)] : []),
];
writeFileSync(`${OUT}team-${USERS}.md`, `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
process.exit(m.errors.length ? 1 : 0);
