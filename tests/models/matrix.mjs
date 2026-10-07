// Model matrix: runs real Work AI tasks through the API on each model, one per tool and a few that
// combine tools, then checks the results (files, answers, tool calls, approvals).
//
//   OLLAMA_KEYS_FILE=… tests/models/run-matrix.sh           all models, all tests
//   MODELS=gpt-oss:20b ONLY=s01-bash,c02-code-fix …         a subset
//
// Writes results.json and summary.md to $OUT (default tests/models/results).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.APP ?? "http://localhost:4100";
const FIX = process.env.FIX ?? "http://127.0.0.1:11600";
const OUT = process.env.OUT ?? new URL("./results", import.meta.url).pathname;
const MODELS = (process.env.MODELS ?? "gemma4:31b,gpt-oss:120b,gpt-oss:20b,nemotron-3-nano:30b,nemotron-3-super,nemotron-3-ultra").split(",");
const ONLY = process.env.ONLY ? process.env.ONLY.split(",") : null;
const PER_MODEL = Number(process.env.PER_MODEL ?? 2);
const TASK_TIMEOUT_MS = Number(process.env.TASK_TIMEOUT_MS ?? 8 * 60_000);
const KEYS = readFileSync(process.env.OLLAMA_KEYS_FILE, "utf8").trim();
mkdirSync(OUT, { recursive: true });

/* ───────────── HTTP with a cookie ───────────── */

let cookie = "";
async function api(method, path, body, { raw = false, form = null } = {}) {
  const headers = { origin: APP, ...(cookie ? { cookie } : {}) };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${APP}${path}`, { method, headers, body: form ?? (body !== undefined ? JSON.stringify(body) : undefined) });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof json === "string" ? json : JSON.stringify(json)}`);
  return json;
}

/* ───────────── Seed data ───────────── */

const words = ["apple", "zebra", "river", "pizza", "stone", "amazing", "cloud", "lazy", "forest", "zone", "bread", "fizz", "candle", "quiz", "garden", "blaze", "window", "zero", "meadow", "puzzle", "orange", "silver", "table", "copper", "lantern", "harbor", "violet", "pepper", "marble", "thunder", "basket", "anchor", "mirror", "pencil", "rocket", "saddle", "tunnel", "velvet", "walnut", "yellow"];
const zCount = words.filter((w) => w.includes("z")).length;

const regions = ["North", "South", "East", "West"];
const products = [
  ["Laptop", 899],
  ["Monitor", 219],
  ["Keyboard", 49],
];
const salesRows = [];
for (let i = 0; i < 36; i++) {
  const r = regions[(i * 7) % 4];
  const [p, price] = products[(i * 5) % 3];
  salesRows.push({ date: `2026-0${1 + (i % 9)}-${String(1 + ((i * 3) % 28)).padStart(2, "0")}`, region: r, product: p, units: 1 + ((i * 11) % 9), unit_price: price });
}
const revenue = Object.fromEntries(regions.map((r) => [r, salesRows.filter((x) => x.region === r).reduce((s, x) => s + x.units * x.unit_price, 0)]));
const ranked = Object.entries(revenue).sort((a, b) => b[1] - a[1]);
const salesCsv = ["date,region,product,units,unit_price", ...salesRows.map((x) => `${x.date},${x.region},${x.product},${x.units},${x.unit_price}`)].join("\n") + "\n";

function chartPng() {
  const dir = mkdtempSync(join(tmpdir(), "matrix-img-"));
  const file = join(dir, "chart.png");
  execFileSync("python3", ["-c", `import matplotlib\nmatplotlib.use("Agg")\nimport matplotlib.pyplot as plt\nf=plt.figure(figsize=(4,2.5))\nf.text(0.5,0.5,"7319",ha="center",va="center",fontsize=72,weight="bold")\nf.savefig("${file}")`]);
  return readFileSync(file);
}

const PRICING_PY = `def apply_discount(price, discount):
    """Return the price after a fractional discount (0.2 means 20% off)."""
    return round(price * discount, 2)


def add_tax(price, rate=0.18):
    return round(price * (1 + rate), 2)


def final_price(price, discount=0, rate=0.18):
    return add_tax(apply_discount(price, discount), rate)
`;
const TEST_PRICING_PY = `import unittest

from pricing import add_tax, apply_discount, final_price


class PricingTest(unittest.TestCase):
    def test_discount(self):
        self.assertEqual(apply_discount(100, 0.2), 80.0)

    def test_no_discount(self):
        self.assertEqual(apply_discount(50, 0), 50.0)

    def test_tax(self):
        self.assertEqual(add_tax(100), 118.0)

    def test_final(self):
        self.assertEqual(final_price(200, 0.25), 177.0)


if __name__ == "__main__":
    unittest.main()
`;
const REFACTOR = {
  "utils.py": `def calc_total(items):
    """Sum of price * qty."""
    return sum(i["price"] * i["qty"] for i in items)


def fmt_money(x):
    return f"\${x:,.2f}"
`,
  "app.py": `from utils import calc_total, fmt_money


def checkout(cart):
    total = calc_total(cart)
    return fmt_money(total)
`,
  "report.py": `import utils


def daily_report(orders):
    lines = []
    for o in orders:
        lines.append(f"{o['id']}: {utils.fmt_money(utils.calc_total(o['items']))}")
    return "\\n".join(lines)
`,
  "test_app.py": `import unittest

from app import checkout
from report import daily_report


class AppTest(unittest.TestCase):
    def test_checkout(self):
        self.assertEqual(checkout([{"price": 2.5, "qty": 4}]), "$10.00")

    def test_report(self):
        self.assertEqual(daily_report([{"id": "A1", "items": [{"price": 1, "qty": 3}]}]), "A1: $3.00")


if __name__ == "__main__":
    unittest.main()
`,
};

const SKILLS = [
  {
    name: "Client invoice",
    description: "Use when someone asks for an invoice or a bill for a client: our invoice file naming, layout, VAT and payment terms.",
    body: `Use this whenever someone asks for an invoice.

- Save each invoice as Markdown in the \`invoices/\` folder, named \`INV-<year>-<number>.md\`, where number is 4 digits starting at 0001 (for example \`invoices/INV-2026-0001.md\`).
- Sections, in this order: **Bill to**, an items table with the columns Description | Qty | Unit price | Amount, then **Subtotal**, **VAT (18%)** and **Total**.
- Payment terms: **Net 15**.
- From: Aatmiq Services, billing@aatmiq.example.`,
  },
  {
    name: "Brand voice",
    description: "Use when writing social media posts, ads or announcements for IronPeak Fitness: tone, length and hashtag rules.",
    body: `Rules for IronPeak Fitness social posts:

- Friendly and energetic, written to the reader ("you").
- Each post is at most 40 words.
- Mention "IronPeak" once in every post.
- No emojis.
- Every post ends with the hashtag #IronPeakStrong.`,
  },
];

/* ───────────── Tests ───────────── */

// Models often write typographic hyphens (U+2011 "‑") and spaces; compare on plain text.
const plain = (s) => String(s ?? "").replace(/[\u2010-\u2015\u2212]/g, "-").replace(/[\u00a0\u202f]/g, " ");
const has = (s, ...needles) => needles.every((n) => (n instanceof RegExp ? n.test(plain(s)) : plain(s).toLowerCase().includes(String(n).toLowerCase())));
const digits = (s) => plain(s).replace(/[,\s]/g, "");
const used = (r, frag) => r.calls.some((c) => c.name.includes(frag));
const okCall = (r, frag) => r.calls.some((c) => c.name.includes(frag) && c.ok);

const TESTS = [
  {
    id: "s01-bash",
    tools: ["bash"],
    prompt: "Use the shell to find out how many CPU cores this machine reports (nproc), and compute 12*37 with python3. Tell me both numbers.",
    verify: (r) => [used(r, "bash"), has(r.answer, "444"), has(r.answer, String(cpus().length))],
  },
  {
    id: "s02-write",
    tools: ["write"],
    prompt: "Create a file named welcome.txt that contains exactly this line: Welcome to Aatmiq, team!",
    verify: async (r) => [(await r.file("welcome.txt"))?.trim() === "Welcome to Aatmiq, team!"],
  },
  {
    id: "s03-read",
    tools: ["read"],
    seeds: { "memo.txt": `${"Quarterly planning notes. ".repeat(40)}\n\nThe project codename is BLUE HERON.\n\n${"Budget review follows next week. ".repeat(30)}` },
    prompt: "Read memo.txt and tell me the project codename.",
    verify: (r) => [has(r.answer, "blue heron"), used(r, "read") || used(r, "grep") || used(r, "bash")],
  },
  {
    id: "s04-edit",
    tools: ["edit"],
    seeds: { "settings.ini": "[server]\nhost = 0.0.0.0\nport = 8080\ndebug = true\n\n[storage]\npath = /var/data\n" },
    prompt: "In settings.ini, change the port from 8080 to 9090 and set debug to false. Edit the file in place and keep everything else unchanged.",
    verify: async (r) => {
      const f = (await r.file("settings.ini")) ?? "";
      return [/port\s*=\s*9090/.test(f), /debug\s*=\s*false/.test(f), f.includes("host = 0.0.0.0") && f.includes("path = /var/data"), !/8080/.test(f)];
    },
  },
  {
    id: "s05-glob",
    tools: ["glob"],
    seeds: { "q1-sales.csv": "a,b\n1,2\n", "q2-sales.csv": "a,b\n3,4\n", "q3-sales.csv": "a,b\n5,6\n", "notes.txt": "notes", "summary.md": "# Summary", "archive-2024.csv.bak": "old" },
    prompt: "Which CSV files (names ending in .csv) are in the folder? Use a file search and list them.",
    verify: (r) => [has(r.answer, "q1-sales.csv", "q2-sales.csv", "q3-sales.csv")],
  },
  {
    id: "s06-grep",
    tools: ["grep"],
    seeds: Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [`email-0${n}.txt`, n === 3 ? "Hi team,\nJust a reminder that invoice INV-4471 is now overdue.\nThanks" : `Hi team,\nNotes for meeting ${n}: nothing urgent.\nThanks`]),
    ),
    prompt: "Search the text files for the invoice number INV-4471 and tell me which file mentions it.",
    verify: (r) => [has(r.answer, "email-03")],
  },
  {
    id: "s07-read-image",
    tools: ["read_image"],
    seeds: { "chart.png": chartPng() },
    prompt: "Look at the image chart.png and tell me the number written in it.",
    verify: (r) => [used(r, "read_image"), has(r.answer, "7319")],
  },
  {
    id: "s08-plan",
    tools: ["todo_write", "write"],
    prompt: "First make a plan with your todo list tool, then do it: create three files, red.txt, green.txt and blue.txt, each containing its own color name in capital letters.",
    verify: async (r) => [
      used(r, "todo_write"),
      (await r.file("red.txt"))?.trim() === "RED",
      (await r.file("green.txt"))?.trim() === "GREEN",
      (await r.file("blue.txt"))?.trim() === "BLUE",
      r.plans.length > 0 && r.plans.at(-1).every((i) => i.status === "completed"),
    ],
  },
  {
    id: "s09-web-search",
    tools: ["web_search"],
    prompt: "Search the web: when does the Northwind Zephyr X2 e-bike launch and what does it cost? Include the source link.",
    verify: (r) => [used(r, "web_search"), has(r.answer, "2027", "2,450"), /example\.(com|org)/.test(r.answer)],
  },
  {
    id: "s10-web-fetch",
    tools: ["web_fetch"],
    // web_fetch only reaches public addresses (intranet pages go through curl, with approval).
    prompt: "Fetch https://example.com and tell me the page's main heading and what the domain is meant for.",
    verify: (r) => [okCall(r, "web_fetch"), has(r.answer, "example domain"), /illustrat|example|documentation/i.test(r.answer)],
  },
  {
    id: "s11-skill",
    tools: ["skill", "write"],
    prompt: "Create an invoice for Acme Corp for 10 hours of consulting at $120 per hour, following our invoice skill.",
    verify: async (r) => {
      const path = (await r.list()).find((p) => /^invoices\/INV-\d{4}-\d{4}\.md$/.test(p));
      const f = path ? ((await r.file(path)) ?? "") : "";
      return [used(r, "skill"), !!path, has(digits(f), "1200", "216", "1416"), has(f, "net 15")];
    },
  },
  {
    id: "s12-subagent",
    tools: ["subagent"],
    seeds: { "words.txt": words.join("\n") + "\n" },
    prompt: "Delegate this to a subagent: count how many lines in words.txt contain the letter z, and report the count back to me.",
    verify: (r) => [used(r, "subagent"), new RegExp(`\\b${zCount}\\b`).test(r.answer)],
  },
  {
    id: "s13-background-job",
    tools: ["bash (background)", "job_output"],
    prompt: "Start this command in the background: sleep 4 && echo build-finished-OK. While it runs, create a file started.txt containing the word started. Then wait for the background job to finish and tell me its output.",
    verify: async (r) => [
      r.calls.some((c) => c.name === "bash" && c.args?.run_in_background === true),
      used(r, "job_"),
      (await r.file("started.txt"))?.trim().toLowerCase() === "started",
      has(r.answer, "build-finished-OK"),
    ],
  },
  {
    id: "s14-connector",
    tools: ["crm.lookup_customer"],
    prompt: "Look up the customer Acme Corp in our CRM and tell me their plan and balance due.",
    verify: (r) => [okCall(r, "lookup_customer"), has(r.answer, "pro", "1,250")],
  },
  {
    id: "s15-connector-approval",
    tools: ["crm.create_ticket (approval)"],
    prompt: "Open a high-priority support ticket in the CRM for Acme Corp with the subject 'Login failures since Monday'.",
    verify: (r) => [okCall(r, "create_ticket"), r.approvals.some((a) => a.toolName.includes("create_ticket")), has(r.answer, "T-50")],
  },
  {
    id: "s16-real-connector",
    tools: ["deepwiki (real MCP)"],
    prompt: "Using DeepWiki, tell me what the expressjs/express repository is and which programming language it is written in.",
    verify: (r) => [okCall(r, "deepwiki"), has(r.answer, "javascript")],
  },
  {
    id: "c01-data-analysis",
    tools: ["todo_write", "bash", "write", "read"],
    seeds: { "sales.csv": salesCsv },
    prompt:
      "Analyze sales.csv with Python (pandas and matplotlib are installed): compute revenue (units × unit_price) per region, save it to region_revenue.csv with columns region,revenue sorted from highest to lowest, draw a bar chart region_revenue.png, and write report.md naming the top region and its revenue.",
    verify: async (r) => {
      const csv = (await r.file("region_revenue.csv")) ?? "";
      const rows = csv.trim().split("\n").slice(1).map((l) => l.split(","));
      const png = await r.bytes("region_revenue.png");
      const rep = (await r.file("report.md")) ?? "";
      return [
        rows[0]?.[0]?.trim() === ranked[0][0] && Math.abs(Number(rows[0]?.[1]) - ranked[0][1]) < 1,
        rows.length === 4,
        !!png && png[0] === 0x89 && png[1] === 0x50,
        has(rep, ranked[0][0]) && has(digits(rep), String(ranked[0][1])),
      ];
    },
  },
  {
    id: "c02-code-fix",
    tools: ["bash", "read", "edit"],
    seeds: { "pricing.py": PRICING_PY, "test_pricing.py": TEST_PRICING_PY },
    prompt: "The tests in test_pricing.py fail. Run them (python3 -m unittest), find the bug in pricing.py, fix it, and run the tests again until they pass. Don't change the tests.",
    verify: async (r) => {
      const dir = mkdtempSync(join(tmpdir(), "matrix-c02-"));
      const code = await r.file("pricing.py");
      const tests = await r.file("test_pricing.py");
      writeFileSync(join(dir, "pricing.py"), code ?? "");
      writeFileSync(join(dir, "test_pricing.py"), tests ?? "");
      let pass = false;
      try {
        execFileSync("python3", ["-m", "unittest", "-q"], { cwd: dir, stdio: "pipe" });
        pass = true;
      } catch {
        /* failing */
      }
      return [pass, tests === TEST_PRICING_PY, used(r, "bash")];
    },
  },
  {
    id: "c03-research-brief",
    tools: ["web_search", "write"],
    prompt: "Research the Northwind Zephyr X2 e-bike on the web and write brief.md with its launch date, price and range, plus a Sources section with the links you used.",
    verify: async (r) => {
      const f = (await r.file("brief.md")) ?? "";
      return [used(r, "web_search"), has(f, "2027", "2,450", "120"), /https:\/\/(news|reviews)\.example\.(com|org)/.test(f)];
    },
  },
  {
    id: "c04-crm-letter",
    tools: ["crm.lookup_customer", "crm.list_open_invoices", "write"],
    prompt:
      "Look up Acme Corp in the CRM, list their open invoices, and write a polite payment reminder email in reminder.md. Start it with a To: line with their contact email address, and mention each open invoice number and the total due.",
    verify: async (r) => {
      const f = (await r.file("reminder.md")) ?? "";
      return [okCall(r, "lookup_customer"), okCall(r, "list_open_invoices"), has(f, "INV-2026-0311", "INV-2026-0342", "ops@acme.example"), has(digits(f), "1250")];
    },
  },
  {
    id: "c05-refactor",
    tools: ["grep", "edit", "bash"],
    seeds: REFACTOR,
    prompt: "Rename the function calc_total to compute_total everywhere in this project (its definition and every use), then run the tests with python3 -m unittest to confirm nothing broke.",
    verify: async (r) => {
      const dir = mkdtempSync(join(tmpdir(), "matrix-c05-"));
      let leftover = false;
      for (const name of Object.keys(REFACTOR)) {
        const f = (await r.file(name)) ?? "";
        if (f.includes("calc_total")) leftover = true;
        writeFileSync(join(dir, name), f);
      }
      let pass = false;
      try {
        execFileSync("python3", ["-m", "unittest", "-q"], { cwd: dir, stdio: "pipe" });
        pass = true;
      } catch {
        /* failing */
      }
      return [!leftover, ((await r.file("utils.py")) ?? "").includes("def compute_total"), pass];
    },
  },
  {
    id: "c06-skill-posts",
    tools: ["skill", "todo_write", "write"],
    prompt: "Using our brand voice skill, write three social media posts announcing our new sunrise yoga class, one per file: posts/post1.txt, posts/post2.txt and posts/post3.txt. Plan the work first.",
    verify: async (r) => {
      const posts = await Promise.all([1, 2, 3].map((n) => r.file(`posts/post${n}.txt`)));
      const good = posts.map((p) => !!p && p.trim().split(/\s+/).length <= 45 && p.includes("#IronPeakStrong") && p.includes("IronPeak") && !/\p{Extended_Pictographic}/u.test(p));
      return [used(r, "skill"), posts.every(Boolean), good.every(Boolean)];
    },
  },
];

/* ───────────── Running a task ───────────── */

async function runTest(t, model, ws) {
  const started = Date.now();
  const task = await api("POST", "/api/work/tasks", { workspaceId: ws, prompt: t.prompt, modelId: model.id, start: false });
  for (const [name, content] of Object.entries(t.seeds ?? {})) {
    const form = new FormData();
    form.append("file", new Blob([content]), name);
    await api("POST", `/api/work/tasks/${task.id}/files`, undefined, { form });
  }
  await api("POST", `/api/work/tasks/${task.id}/messages`, { prompt: t.prompt });
  const approvals = [];
  let d;
  for (;;) {
    await new Promise((res) => setTimeout(res, 2500));
    d = await api("GET", `/api/work/tasks/${task.id}`);
    const pending = (await api("GET", "/api/work/approvals")).filter((a) => a.taskId === task.id);
    for (const a of pending) {
      approvals.push({ toolName: a.toolName, reason: a.reason });
      await api("POST", `/api/work/approvals/${a.id}`, { decision: "approve" }).catch(() => undefined);
    }
    if (["completed", "failed", "cancelled"].includes(d.task.status) && d.events.some((e) => e.kind === "status")) break;
    if (Date.now() - started > TASK_TIMEOUT_MS) {
      await api("POST", `/api/work/tasks/${task.id}/cancel`).catch(() => undefined);
      d = await api("GET", `/api/work/tasks/${task.id}`);
      d.timedOut = true;
      break;
    }
  }
  const results = new Map(d.events.filter((e) => e.kind === "tool_result").map((e) => [e.data.callId, e.data]));
  const calls = d.events
    .filter((e) => e.kind === "tool_call")
    .map((e) => {
      const res = results.get(e.data.callId);
      return { name: e.data.name, args: e.data.args, ok: !!res && !res.isError, text: res ? String(res.text).slice(0, 400) : "(no result)" };
    });
  const answer = d.events.filter((e) => e.kind === "assistant" && e.data.text).at(-1)?.data.text ?? "";
  const listing = await api("GET", `/api/work/tasks/${task.id}/files`).catch(() => ({ files: [] }));
  const r = {
    calls,
    answer,
    approvals,
    plans: d.events.filter((e) => e.kind === "plan").map((e) => e.data.items),
    list: async () => listing.files.map((f) => f.path),
    file: async (p) => {
      const res = await api("GET", `/api/work/tasks/${task.id}/files/content?path=${encodeURIComponent(p)}`, undefined, { raw: true });
      return res.ok ? await res.text() : null;
    },
    bytes: async (p) => {
      const res = await api("GET", `/api/work/tasks/${task.id}/files/content?path=${encodeURIComponent(p)}`, undefined, { raw: true });
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    },
  };
  let checks = [];
  try {
    checks = await t.verify(r);
  } catch (e) {
    checks = [false];
    r.verifyError = String(e);
  }
  return {
    test: t.id,
    model: model.key,
    taskId: task.id,
    status: d.timedOut ? "timeout" : d.task.status,
    error: d.task.error,
    seconds: Math.round((Date.now() - started) / 1000),
    inputTokens: d.task.inputTokens,
    outputTokens: d.task.outputTokens,
    checks,
    pass: d.task.status === "completed" && checks.length > 0 && checks.every(Boolean),
    calls: calls.map(({ name, ok, text, args }) => ({ name, ok, ...(ok ? {} : { text, args }) })),
    approvals,
    plans: r.plans.length,
    answer: answer.slice(0, 1200),
    files: (await r.list()).slice(0, 40),
  };
}

/* ───────────── Setup ───────────── */

async function setup() {
  const st = await api("GET", "/api/public/status");
  if (st.setupRequired) {
    await api("POST", "/api/setup", { orgName: "Matrix Labs", name: "Mira Admin", email: "admin@matrix.test", password: "correct-horse-battery" });
  } else {
    await api("POST", "/api/auth/sign-in/email", { email: "admin@matrix.test", password: "correct-horse-battery" }).catch(async () => {
      await api("POST", "/api/setup", { orgName: "Matrix Labs", name: "Mira Admin", email: "admin@matrix.test", password: "correct-horse-battery" });
    });
  }
  const me = await api("GET", "/api/me");
  const ws = me.workspaces[0].id;
  const providers = await api("GET", "/api/admin/providers");
  let prov = providers.find((p) => p.name === "Ollama Cloud");
  if (!prov) prov = await api("POST", "/api/admin/providers", { name: "Ollama Cloud", type: "ollama", baseUrl: "https://ollama.com", apiKey: KEYS });
  const existing = await api("GET", "/api/admin/models");
  const models = [];
  for (const key of MODELS) {
    let m = existing.find((x) => x.modelKey === key);
    if (!m) m = await api("POST", "/api/admin/models", { providerId: prov.id, modelKey: key, displayName: key, sections: ["chat", "work", "code"], contextLength: 131072 });
    models.push({ id: m.id, key });
  }
  await api("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: models.map((m) => m.id), defaultModelId: models[0].id });
  await api("PUT", "/api/admin/work", { searxngUrl: `${FIX}/searx`, approvals: "risky", maxConcurrentPerUser: 20 });
  const connectors = await api("GET", "/api/admin/connectors");
  if (!connectors.some((c) => c.name === "crm")) await api("POST", "/api/admin/connectors", { name: "crm", displayName: "CRM", url: `${FIX}/mcp`, approveTools: "create_*" });
  if (!connectors.some((c) => c.name === "deepwiki")) await api("POST", "/api/admin/connectors", { name: "deepwiki", displayName: "DeepWiki", url: "https://mcp.deepwiki.com/mcp", approveTools: "" });
  const skills = await api("GET", "/api/work/skills");
  for (const s of SKILLS) if (!skills.some((x) => x.name === s.name)) await api("POST", "/api/work/skills", { ...s, scope: "org" });
  return { ws, models };
}

/* ───────────── Main ───────────── */

const { ws, models } = await setup();
const tests = TESTS.filter((t) => !ONLY || ONLY.includes(t.id));
const all = [];
const save = () => writeFileSync(join(OUT, "results.json"), JSON.stringify(all, null, 1));
console.log(`${models.length} models × ${tests.length} tests`);

await Promise.all(
  models.map(async (model) => {
    const queue = [...tests];
    await Promise.all(
      Array.from({ length: PER_MODEL }, async () => {
        for (let t = queue.shift(); t; t = queue.shift()) {
          let res;
          try {
            res = await runTest(t, model, ws);
          } catch (e) {
            res = { test: t.id, model: model.key, status: "harness-error", error: String(e), checks: [], pass: false, calls: [] };
          }
          all.push(res);
          save();
          const bad = res.calls.filter((c) => !c.ok).length;
          console.log(`${res.pass ? "PASS" : "FAIL"} ${model.key.padEnd(20)} ${t.id.padEnd(24)} ${res.status} ${res.seconds ?? "-"}s calls=${res.calls.length} errors=${bad} checks=${JSON.stringify(res.checks)}${res.error ? ` error=${String(res.error).slice(0, 120)}` : ""}`);
        }
      }),
    );
  }),
);

/* ───────────── Summary ───────────── */

const lines = ["# Model matrix", "", `| Test | ${models.map((m) => m.key).join(" | ")} |`, `|---|${models.map(() => "---").join("|")}|`];
for (const t of tests) {
  lines.push(`| ${t.id} | ${models.map((m) => {
    const r = all.find((x) => x.test === t.id && x.model === m.key);
    if (!r) return "–";
    const errs = r.calls.filter((c) => !c.ok).length;
    return `${r.pass ? "✅" : "❌"} ${r.seconds ?? "-"}s${errs ? ` (${errs} err)` : ""}`;
  }).join(" | ")} |`);
}
lines.push(`| **passed** | ${models.map((m) => `**${all.filter((x) => x.model === m.key && x.pass).length}/${tests.length}**`).join(" | ")} |`);
lines.push("", "## Tool calls", "", "| Model | Calls | Failed | Input tokens | Output tokens |", "|---|---|---|---|---|");
for (const m of models) {
  const rs = all.filter((x) => x.model === m.key);
  const calls = rs.flatMap((x) => x.calls);
  lines.push(`| ${m.key} | ${calls.length} | ${calls.filter((c) => !c.ok).length} | ${rs.reduce((s, x) => s + (x.inputTokens ?? 0), 0).toLocaleString()} | ${rs.reduce((s, x) => s + (x.outputTokens ?? 0), 0).toLocaleString()} |`);
}
lines.push("", "## Failed tool calls", "");
for (const r of all) for (const c of r.calls.filter((c) => !c.ok)) lines.push(`- ${r.model} · ${r.test} · \`${c.name}\`: ${String(c.text).replace(/\s+/g, " ").slice(0, 220)}`);
writeFileSync(join(OUT, "summary.md"), lines.join("\n") + "\n");
console.log(`\nwrote ${join(OUT, "summary.md")}`);
