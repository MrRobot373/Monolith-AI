/**
 * Work AI in the browser (started by run-work.sh): the real agent runtime driven by the scripted
 * fake model on :11500, which also serves a fake SearXNG (/searx) and MCP server (/mcp).
 */
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const FAKE = "http://localhost:11500";
const OUT = new URL("./results-work/shots/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
const consoleErrors = [];
let n = 0;

async function newUser(tag, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (40\d)/.test(m.text())) consoleErrors.push(`[${tag}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.setDefaultTimeout(15000);
  return { ctx, page };
}
async function step(area, name, page, fn) {
  n++;
  const id = String(n).padStart(2, "0");
  try {
    await fn();
    results.push({ id, area, name, ok: true });
  } catch (e) {
    results.push({ id, area, name, ok: false, err: e.message.split("\n")[0].slice(0, 220) });
    await page?.screenshot({ path: `${OUT}FAIL-${id}.png` }).catch(() => {});
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png` });
const api = async (page, method, path, data) => {
  const r = await page.request.fetch(`${APP}${path}`, { method, data, headers: { origin: APP } });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const status = (page) => page.getByTestId("task-status").first().getAttribute("data-status");
const waitStatus = async (page, ...want) => {
  for (let i = 0; i < 150; i++) {
    if (want.includes(await status(page).catch(() => null))) return;
    await page.waitForTimeout(200);
  }
  throw new Error(`status stayed ${await status(page)}; wanted ${want.join("/")}`);
};
const send = async (page, text) => {
  await page.getByTestId("work-input").fill(text);
  await page.getByTestId("work-send").click();
};

/* ═════════════ Setup ═════════════ */
const { page } = await newUser("owner");
await step("Setup", "Owner sets up, adds a model for Work AI and web search", page, async () => {
  await page.goto(`${APP}/login`);
  const r = await api(page, "POST", "/api/setup", { orgName: "Acme Labs", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
  expect(r.status === 200, `setup ${r.status}`);
  const me = await api(page, "GET", "/api/me");
  const ws = me.json.workspaces[0].id;
  const p = await api(page, "POST", "/api/admin/providers", { name: "Local vLLM", type: "openai_compatible", baseUrl: `${FAKE}/v1` });
  const m = await api(page, "POST", "/api/admin/models", { providerId: p.json.id, modelKey: "qwen3:8b", displayName: "Qwen3 8B", sections: ["chat", "work"], contextLength: 32768 });
  const all = (await api(page, "GET", "/api/admin/models")).json.map((x) => x.id);
  await api(page, "PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: all, defaultModelId: m.json.id });
});

await step("Admin", "Admin → Work AI: SearXNG test and save", page, async () => {
  await page.goto(`${APP}/admin/work`);
  await page.locator("h1", { hasText: "Work AI" }).waitFor();
  await page.getByTestId("searxng-url").fill(`${FAKE}/searx`);
  await page.click("button:has-text('Test')");
  await page.locator("[data-sonner-toast]", { hasText: "SearXNG works" }).waitFor();
  await page.getByTestId("save-work-settings").click();
  await page.locator("[data-sonner-toast]", { hasText: "Work AI settings saved" }).waitFor();
  await shot(page, "admin-work");
});

/* ═════════════ A multi-step task ═════════════ */
let taskUrl = "";
await step("Tasks", "Work home: greeting, starters, model and policy hints", page, async () => {
  await page.goto(`${APP}/app/work`);
  await page.getByText("What should I work on, Asha?").waitFor();
  await page.getByText("Analyze a spreadsheet").waitFor();
  await page.getByText("Private web search on").waitFor();
  await page.getByText("Qwen3 8B").first().waitFor();
  await shot(page, "work-home-empty");
});
await step("Tasks", "Start a task: plan, steps, files and the answer stream in", page, async () => {
  await send(page, "demo: build a small sales report");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  taskUrl = page.url();
  await page.getByTestId("task-user").filter({ hasText: "demo: build a small sales report" }).waitFor();
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "North leads South by 25" }).waitFor();
  const tools = await page.getByTestId("task-step").evaluateAll((els) => els.map((e) => e.getAttribute("data-tool")));
  expect(tools.includes("bash") && tools.includes("write") && tools.includes("todo_write"), `steps: ${tools}`);
  await page.getByTestId("plan").getByText("Summarize the result").waitFor();
  await shot(page, "task-done");
});
await step("Tasks", "The bell says the task finished and opens it", page, async () => {
  await page.goto(`${APP}/app/work`);
  await page.locator('button[aria-label^="Notifications ("]').click();
  await page.getByText(/^Task finished:/).first().click();
  await page.waitForURL(taskUrl);
  await page.getByTestId("task-answer").filter({ hasText: "North leads South by 25" }).waitFor();
});
await step("Tasks", "Expand a step to see the command and its output", page, async () => {
  await page.getByTestId("task-step").filter({ hasText: "Ran" }).first().locator("button").first().click();
  await page.getByText("North,120").first().waitFor();
});
await step("Files", "Files panel lists the outputs; preview and download a file", page, async () => {
  await page.getByTestId("files-toggle").click();
  const files = page.getByTestId("files");
  await files.getByText("report.md").waitFor();
  await files.getByText("sales.csv").waitFor();
  await files.getByText("report.md").click();
  await page.getByTestId("file-preview").filter({ hasText: "# Sales report" }).waitFor();
  await shot(page, "file-preview");
  const [dl] = await Promise.all([page.waitForEvent("download"), page.click('[role="dialog"] >> text=Download')]);
  expect(dl.suggestedFilename() === "report.md", dl.suggestedFilename());
  await page.keyboard.press("Escape");
});

/* ═════════════ Approvals ═════════════ */
await step("Approvals", "A delete waits for approval: card, sidebar badge, inbox", page, async () => {
  await send(page, "run: rm sales.csv");
  await waitStatus(page, "needs_approval");
  const card = page.getByTestId("approval-card");
  await card.getByText("Deletes files").waitFor();
  await card.getByText("rm sales.csv").waitFor();
  await page.getByLabel("1 waiting for approval").waitFor();
  await shot(page, "approval");
});
await step("Approvals", "Reject keeps the file; the agent is told no", page, async () => {
  await page.getByTestId("reject").click();
  await page.getByTestId("approval-note").filter({ hasText: "Rejected" }).waitFor();
  await waitStatus(page, "completed");
  await page.getByTestId("files").getByText("sales.csv").waitFor();
});
await step("Approvals", "Approve from the Work home inbox; the file is deleted", page, async () => {
  await send(page, "run: rm sales.csv");
  await waitStatus(page, "needs_approval");
  await page.goto(`${APP}/app/work`);
  await page.getByTestId("approvals-inbox").getByText("Review").click();
  await page.waitForURL(taskUrl);
  await page.getByTestId("approve").click();
  await waitStatus(page, "completed");
  await page.getByTestId("files-toggle").click();
  await page.getByTestId("files").getByText("report.md").waitFor();
  expect((await page.getByTestId("files").getByText("sales.csv").count()) === 0, "sales.csv still listed");
});

/* ═════════════ Web search, files in, stop ═════════════ */
await step("Search", "Private web search through SearXNG", page, async () => {
  await send(page, "search: travel policy");
  await waitStatus(page, "completed");
  await page.getByTestId("task-step").filter({ hasText: "Searched the web" }).waitFor();
  await page.getByTestId("task-answer").locator('a[href="https://intranet.example/travel-policy"]', { hasText: "Travel policy 2026" }).waitFor();
});
/* ═════════════ Browser ═════════════ */
const SIGNUP = "browse: http://localhost:11500/signup";
await step("Browser", "The organization's private network is off limits by default", page, async () => {
  await send(page, SIGNUP);
  await waitStatus(page, "completed");
  await page.getByTestId("task-step").filter({ hasText: "Opened in the browser" }).first().waitFor();
  await page.getByTestId("task-answer").filter({ hasText: "private network" }).waitFor();
});
let browserTask = "";
await step("Browser", "Admin allows an internal site; the agent fills in its form, submitting waits for approval", page, async () => {
  browserTask = page.url();
  await page.goto(`${APP}/admin/work`);
  await page.getByTestId("browser-allowed-hosts").fill("localhost");
  await page.getByTestId("save-work-settings").click();
  await page.getByText("Work AI settings saved").waitFor();
  await page.goto(browserTask);
  await send(page, SIGNUP);
  await waitStatus(page, "needs_approval");
  const card = page.getByTestId("approval-card");
  await card.getByText("Submits a form on a website").waitFor();
  await shot(page, "browser-approval");
  await page.getByTestId("approve").click();
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "Welcome, Ada Lovelace!" }).waitFor();
  await page.getByTestId("task-step").filter({ hasText: "Typed and submitted" }).first().waitFor();
  await page.getByTestId("task-step").filter({ hasText: "Took a screenshot" }).first().waitFor();
  await page.getByTestId("files-toggle").click();
  await page.getByTestId("files").getByText(/screenshot-.*\.png/).first().waitFor();
  await shot(page, "browser-done");
});

await step("Tasks", "Start a task with a file; the agent works on it", page, async () => {
  const f = join(tmpdir(), "notes.txt");
  writeFileSync(f, "alpha\nbeta\ngamma\n");
  await page.goto(`${APP}/app/work`);
  await page.getByTestId("work-file-input").setInputFiles(f);
  await page.getByText("notes.txt").waitFor();
  await send(page, "run: wc -l notes.txt");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "3 notes.txt" }).waitFor();
});
await step("Tasks", "Stop a long-running task", page, async () => {
  await page.goto(`${APP}/app/work`);
  await send(page, "run: sleep 30");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await page.getByTestId("task-step").filter({ hasText: "sleep 30" }).waitFor();
  await shot(page, "task-running");
  await page.getByTestId("work-stop").click();
  await waitStatus(page, "cancelled");
  await page.getByText("Stopped. Send a message to continue.").waitFor();
});
await step("Tasks", "A stopped task continues from its history", page, async () => {
  await send(page, "are you back?");
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "are you back?" }).waitFor();
});
await step("Tasks", "Task list shows statuses; rename and pin from the menu", page, async () => {
  await page.click("button[aria-label='Task options']");
  await page.click("text=Rename");
  await page.fill('[role="dialog"] input', "Check the stop button");
  await page.click('[role="dialog"] >> button:has-text("Save")');
  await page.getByTestId("task-title").filter({ hasText: "Check the stop button" }).waitFor();
  await page.goto(`${APP}/app/work`);
  const rows = page.getByTestId("task-row");
  await rows.filter({ hasText: "Check the stop button" }).waitFor();
  expect((await rows.count()) === 3, `rows ${await rows.count()}`);
  await shot(page, "work-home-tasks");
});

await step("Isolation", "A task runs as its own user, can't write outside its folder or read the server's environment", page, async () => {
  await page.goto(`${APP}/app/work`);
  await send(page, "run: id -u; touch /dev/shm/aatmiq-escape && echo ESCAPED; cat /proc/1/environ | head -c 40; echo; echo done");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "completed");
  const out = await page.getByTestId("task-answer").last().innerText();
  const uid = Number(/returned: (\d+)/.exec(out)?.[1]);
  expect(uid >= 100000, `uid ${uid}: ${out}`);
  expect(!out.includes("ESCAPED"), `wrote outside the folder: ${out}`);
  expect(/permission denied/i.test(out), `environ readable: ${out}`);
});

/* ═════════════ Skills, schedules, connectors ═════════════ */
await step("Skills", "Create an org skill; the agent sees it", page, async () => {
  await page.goto(`${APP}/app/work/skills`);
  await page.getByTestId("new-skill").click();
  await page.getByTestId("skill-name").fill("Weekly report");
  await page.getByTestId("skill-description").fill("Use when writing the weekly status report");
  await page.getByTestId("skill-body").fill("Start with a three-line summary, then a table of risks.");
  await page.locator('[role="dialog"] select').selectOption("org");
  await page.getByTestId("save-skill").click();
  await page.getByTestId("skill-row").filter({ hasText: "Weekly report" }).waitFor();
  await shot(page, "skills");
});
await step("Skills", "Browse the built-in library, read a skill, switch one off", page, async () => {
  await page.goto(`${APP}/app/work/skills`);
  const lib = page.getByTestId("skill-library");
  await lib.getByText("Library").first().waitFor();
  await page.getByTestId("library-row").first().waitFor();
  if ((await page.getByTestId("library-row").count()) < 50) throw new Error("library is missing skills");
  await page.getByTestId("library-search").fill("excel");
  const row = page.locator('[data-testid="library-row"][data-slug="excel-spreadsheets"]');
  await row.waitFor();
  await row.locator("button").first().click();
  await page.getByTestId("library-skill-body").getByText("Write formatted sheets").waitFor();
  await shot(page, "skill-library-reader");
  await page.keyboard.press("Escape");
  await page.getByTestId("library-search").fill("seo");
  const seo = page.locator('[data-testid="library-row"][data-slug="seo"]');
  await seo.getByRole("switch").click();
  await seo.getByText("Off").waitFor();
  await seo.getByRole("switch").click();
  await page.getByTestId("library-search").fill("");
  await shot(page, "skill-library");
});
await step("Schedules", "Schedule a weekday task, preview runs, run it now", page, async () => {
  await page.goto(`${APP}/app/work/schedules`);
  await page.getByTestId("new-schedule").click();
  await page.getByTestId("schedule-name").fill("Morning brief");
  await page.getByTestId("schedule-prompt").fill("good morning, brief me");
  await page.getByTestId("schedule-preview").getByText("Next runs:").waitFor();
  await page.getByTestId("save-schedule").click();
  const row = page.getByTestId("schedule-row").filter({ hasText: "Morning brief" });
  await row.getByText(/Weekdays at 09:00/).waitFor();
  await shot(page, "schedules");
  await row.getByText("Run now").click();
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "good morning" }).waitFor();
});
await step("Connectors", "Add an MCP connector and list its tools", page, async () => {
  await page.goto(`${APP}/admin/work`);
  await page.getByTestId("add-connector").click();
  await page.getByTestId("catalog-canva").waitFor();
  await page.getByTestId("catalog-search").fill("mail");
  await page.getByTestId("catalog-gmail").waitFor();
  await shot(page, "connector-catalog");
  await page.getByTestId("catalog-custom").click();
  await page.getByTestId("connector-display-name").fill("Notes");
  await page.getByTestId("connector-url").fill(`${FAKE}/mcp`);
  await page.getByTestId("connector-approvals").selectOption("custom");
  await page.getByTestId("connector-rule").fill("create_*");
  await page.getByTestId("save-connector").click();
  const row = page.getByTestId("connector-row").filter({ hasText: "Notes" });
  await row.waitFor();
  await row.getByText("Test").click();
  await page.getByTestId("connector-tools").getByText("create_note").waitFor();
  await shot(page, "connector-tools");
  await page.keyboard.press("Escape");
});
await step("Connectors", "The agent uses the connector after approval", page, async () => {
  await page.goto(`${APP}/app/work`);
  await send(page, 'use mcp__notes__create_note {"text":"Ship Work AI"}');
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "needs_approval");
  await page.getByTestId("approval-card").getByText("Uses the notes connector").waitFor();
  await page.getByTestId("approve").click();
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "Saved note #1: Ship Work AI" }).waitFor();
});

await step("Connectors", "Gmail from the catalog asks the admin for an OAuth app", page, async () => {
  await page.goto(`${APP}/admin/work`);
  await page.getByTestId("add-connector").click();
  await page.getByTestId("catalog-gmail").click();
  await page.getByTestId("redirect-uri").waitFor();
  if (!(await page.getByTestId("redirect-uri").inputValue()).endsWith("/api/connectors/oauth/callback")) throw new Error("wrong redirect URI");
  if (!(await page.getByTestId("save-connector").isDisabled())) throw new Error("Gmail saved without a client ID");
  await shot(page, "connector-gmail-setup");
  await page.keyboard.press("Escape");
});
await step("Connectors", "GitLab needs no OAuth app, says what GitLab must allow, and takes a self-managed URL", page, async () => {
  await page.goto(`${APP}/admin/work`);
  await page.getByTestId("add-connector").click();
  await page.getByTestId("catalog-search").fill("gitlab");
  await page.getByTestId("catalog-gitlab").click();
  await page.getByTestId("connector-prerequisite").filter({ hasText: "allows MCP access" }).waitFor();
  if (await page.getByTestId("redirect-uri").count()) throw new Error("GitLab asked for an OAuth app");
  const url = page.getByTestId("connector-url");
  if ((await url.inputValue()) !== "https://gitlab.com/api/v4/mcp") throw new Error(`default URL ${await url.inputValue()}`);
  if (await url.isDisabled()) throw new Error("URL can't be changed for a self-managed GitLab");
  await url.fill("https://gitlab.acme.test/api/v4/mcp");
  if (await page.getByTestId("save-connector").isDisabled()) throw new Error("can't save");
  await shot(page, "connector-gitlab");
  await page.keyboard.press("Escape");
});
await step("Connectors", "A person connects their own account (OAuth) and a task uses it", page, async () => {
  await page.goto(`${APP}/admin/work`);
  await page.getByTestId("add-connector").click();
  await page.getByTestId("catalog-custom").click();
  await page.getByTestId("connector-display-name").fill("Mail");
  await page.getByTestId("connector-url").fill(`${FAKE}/oauth/mcp`);
  await page.getByTestId("connector-auth").selectOption("oauth");
  await page.getByTestId("save-connector").click();
  await page.getByTestId("connector-row").filter({ hasText: "Each person signs in" }).waitFor();
  await page.goto(`${APP}/app/work/connections`);
  const row = page.getByTestId("connection-row").filter({ hasText: "Mail" });
  await row.getByTestId("connect").click();
  await page.waitForURL(/\/app\/work\/connections/);
  await row.getByText("Signed in as asha@acme.test").waitFor();
  await shot(page, "connections");
  await page.goto(`${APP}/app/work`);
  await send(page, "use mcp__mail__get_inbox {}");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "3 unread emails for asha@acme.test (via mail-token-1)" }).waitFor();
});

/* ═════════════ Projects ═════════════ */
let projectId = "";
let projectTaskUrl = "";
await step("Projects", "Start a task from a project: it follows the instructions and gets the project's files", page, async () => {
  const ws = (await api(page, "GET", "/api/me")).json.workspaces[0].id;
  const p = await api(page, "POST", "/api/projects", { workspaceId: ws, name: "Launch plan", instructions: "Keep answers short." });
  projectId = p.json.id;
  await api(page, "POST", `/api/projects/${projectId}/sources/note`, { title: "Budget", content: "The launch budget is 42 lakh." });
  await page.goto(`${APP}/app/projects/${projectId}`);
  await page.getByTestId("project-new-task").click();
  await page.waitForURL(/\/app\/work\?project=/);
  await page.getByTestId("task-project-chip").getByText("Launch plan").waitFor();
  await shot(page, "project-task-start");
  await send(page, 'run: cat project/README.md project/Budget.md; echo "Launch findings" > findings.md');
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  projectTaskUrl = page.url();
  await waitStatus(page, "completed");
  await page.getByTestId("task-project").getByText("Launch plan").waitFor();
  await page.getByTestId("task-step").first().click();
  await page.getByText("The launch budget is 42 lakh.").first().waitFor();
});

await step("Projects", "Save a result to the project and share the task with it", page, async () => {
  await page.goto(projectTaskUrl);
  await page.getByTestId("files-toggle").click();
  const row = page.getByTestId("files").locator("li").filter({ hasText: "findings.md" });
  await page.getByTestId("files").getByText("project/Budget.md").waitFor();
  await row.hover();
  await row.getByTestId("save-file").click();
  await page.getByText("Saved findings.md to Launch plan").waitFor();
  expect((await page.getByTestId("save-answer").count()) === 1, "save offered on more than the final answer");
  await page.getByTestId("save-answer").click();
  await page.getByText("Saved to Launch plan").waitFor();
  await page.getByLabel("Task options").click();
  await page.getByRole("menuitem", { name: "Share to project" }).click();
  await page.getByText("Shared to Launch plan").waitFor();
  await page.goto(`${APP}/app/projects/${projectId}`);
  await page.getByTestId("project-tasks").getByText("Shared").waitFor();
  await page.getByText("findings.md").first().waitFor();
  await shot(page, "project-tasks");
});

await step("Projects", "A colleague in the project reads the shared task but can't change it", page, async () => {
  const ws = (await api(page, "GET", "/api/me")).json.workspaces[0].id;
  const inv = await api(page, "POST", "/api/admin/invites", { email: "ravi@acme.test", workspaces: [{ workspaceId: ws, role: "member" }] });
  const { page: ravi } = await newUser("ravi");
  await ravi.goto(`${APP}/login`);
  const acc = await api(ravi, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name: "Ravi Member", password: "a-good-password-1" });
  expect(acc.status === 200, `accept ${acc.status}`);
  const raviId = (await api(ravi, "GET", "/api/me")).json.user.id;
  await api(page, "PUT", `/api/projects/${projectId}/members`, { userId: raviId, role: "chat" });
  await ravi.goto(`${APP}/app/projects/${projectId}`);
  await ravi.getByTestId("project-title").waitFor();
  await ravi.goto(projectTaskUrl);
  await ravi.getByTestId("shared-task-note").getByText("Shared by Asha Owner in Launch plan").waitFor();
  expect((await ravi.getByTestId("work-input").count()) === 0, "colleague can type into the task");
  expect((await ravi.getByLabel("Task options").count()) === 0, "colleague has the task menu");
  await shot(ravi, "project-task-shared");
  await ravi.context().close();
});

await step("Projects", "Project settings: choose the connectors its tasks may use", page, async () => {
  await page.goto(`${APP}/app/projects/${projectId}`);
  await page.getByLabel("Project options").click();
  await page.getByText("Project settings").click();
  await page.getByTestId("project-connectors-mode").selectOption("some");
  await page.getByTestId("project-connector-Notes").check();
  await shot(page, "project-connectors");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByText("Project saved").waitFor();
  const p = await api(page, "GET", `/api/projects/${projectId}`);
  expect(p.json.connectorIds?.length === 1, `connectors ${JSON.stringify(p.json.connectorIds)}`);
});

await step("Keys", "A provider key past its limit is skipped; admins see it resting", page, async () => {
  const ws = (await api(page, "GET", "/api/me")).json.workspaces[0].id;
  const p = await api(page, "POST", "/api/admin/providers", { name: "Cloud with spare keys", type: "openai_compatible", baseUrl: `${FAKE}/v1`, apiKey: "exhausted-1\nspare-2" });
  const m = await api(page, "POST", "/api/admin/models", { providerId: p.json.id, modelKey: "gemma3:12b", displayName: "Cloud model", sections: ["chat", "work"] });
  const all = (await api(page, "GET", "/api/admin/models")).json.map((x) => x.id);
  await api(page, "PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: all, defaultModelId: m.json.id });
  await page.goto(`${APP}/app/work`);
  await send(page, "run: echo rotated");
  await page.waitForURL(/\/app\/work\/[\w-]+$/);
  await waitStatus(page, "completed");
  await page.getByTestId("task-answer").filter({ hasText: "rotated" }).waitFor();
  await page.goto(`${APP}/admin/models`);
  const keys = page.getByTestId("provider-keys").filter({ hasText: "2 API keys" });
  await keys.getByText("1 ready").waitFor();
  await keys.getByText("#1 resting").waitFor();
  await page.screenshot({ path: `${OUT}provider-keys.png` });
  // Back to the default model for the remaining checks.
  const def = (await api(page, "GET", "/api/admin/models")).json.find((x) => x.modelKey === "qwen3:8b");
  await api(page, "PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: all, defaultModelId: def.id });
});

/* ═════════════ Looks ═════════════ */
await step("Looks", "Light theme and phone layout of a task", page, async () => {
  await page.goto(taskUrl);
  await page.evaluate(() => localStorage.setItem("aatmiq.theme", "light"));
  await page.reload();
  await page.getByTestId("task-answer").first().waitFor();
  await shot(page, "task-light");
  await page.evaluate(() => localStorage.setItem("aatmiq.theme", "dark"));
  const { page: phone } = await newUser("phone", { viewport: { width: 390, height: 844 }, storageState: await page.context().storageState() });
  await phone.goto(taskUrl);
  await phone.getByTestId("task-answer").first().waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(!overflow, "horizontal scroll on phone");
  await shot(phone, "task-phone");
});

/* ═════════════ Report ═════════════ */
await browser.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} [${r.area}] ${r.name}${r.ok ? "" : `\n      ${r.err}`}`);
if (consoleErrors.length) console.log(`\nConsole errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 15).join("\n")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
