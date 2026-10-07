/**
 * Aatmiq Code in the browser (run with run-work.sh: E2E_SCRIPT=…/code.mjs): workspaces, the IDE
 * inside Aatmiq, terminals, the Aatmiq panel (agent with approvals) and cloning from Git.
 * Needs the IDE build (pnpm --filter @aatmiq/code build).
 */
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const FAKE = "http://localhost:11500";
const OUT = new URL("./results-code/shots/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

// A Git repository served over plain HTTP ("dumb" protocol) for the clone test.
const gitRoot = mkdtempSync(join(tmpdir(), "aatmiq-git-"));
const src = join(gitRoot, "src");
mkdirSync(src);
writeFileSync(join(src, "README.md"), "# Invoices\n\nA small service.\n");
writeFileSync(join(src, "invoices.py"), "def total(items):\n    return sum(i['amount'] for i in items)\n");
const git = (args, cwd) => execFileSync("git", args, { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
git(["init", "-q", "-b", "main"], src);
git(["add", "."], src);
git(["commit", "-qm", "init"], src);
git(["clone", "-q", "--bare", src, join(gitRoot, "invoices.git")], gitRoot);
git(["update-server-info"], join(gitRoot, "invoices.git"));
const gitServer = createServer((req, res) => {
  const file = normalize(join(gitRoot, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  try {
    if (!file.startsWith(gitRoot) || !statSync(file).isFile()) throw new Error();
    res.writeHead(200, { "content-type": extname(file) ? "application/octet-stream" : "text/plain" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404).end();
  }
}).listen(11700);

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
const consoleErrors = [];
let n = 0;
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
const page = await ctx.newPage();
page.on("console", (m) => {
  // vsda: Microsoft's closed-source signing module, absent from every open-source build.
  if (m.type() === "error" && !/status of 40\d/.test(m.text()) && !UNLOAD_NOISE.test(m.text())) consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));
const failedRequests = [];
page.on("requestfailed", (r) => failedRequests.push(`${r.failure()?.errorText} ${r.url().slice(0, 160)}`));
// Messages the workbench logs while a page unloads between steps (navigation), not failures.
const UNLOAD_NOISE = /Long running operations during shutdown|BroadcastChannel|Unable to load and parse grammar|DeprecationWarning/;
page.setDefaultTimeout(20000);

async function step(area, name, fn) {
  n++;
  const id = String(n).padStart(2, "0");
  try {
    await fn();
    results.push({ id, area, name, ok: true });
  } catch (e) {
    results.push({ id, area, name, ok: false, err: e.message.split("\n")[0].slice(0, 220) });
    await page.screenshot({ path: `${OUT}FAIL-${id}.png` }).catch(() => {});
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const api = async (method, path, data) => {
  const r = await page.request.fetch(`${APP}${path}`, { method, data, headers: { origin: APP } });
  return { status: r.status(), json: await r.json().catch(() => null) };
};
const ide = () => page.frameLocator('[data-testid="ide-frame"]');
// Set (e.g. http://ide.localhost:3300) when the stack serves the IDE from its own host.
const IDE_URL = process.env.IDE_URL || "";
const panel = () => ide().frameLocator("iframe.webview").frameLocator("iframe");
const explorer = () => ide().locator(".explorer-folders-view");
const waitFor = async (fn, ms = 30000) => {
  const until = Date.now() + ms;
  for (;;) {
    if (await fn().catch(() => false)) return;
    if (Date.now() > until) throw new Error("timed out");
    await page.waitForTimeout(300);
  }
};

/* ═════════════ Setup ═════════════ */
await step("Setup", "Owner sets up and enables a model for Code", async () => {
  await page.goto(`${APP}/login`);
  expect((await api("POST", "/api/setup", { orgName: "Acme Labs", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status === 200, "setup");
  const ws = (await api("GET", "/api/me")).json.workspaces[0].id;
  const p = await api("POST", "/api/admin/providers", { name: "Local vLLM", type: "openai_compatible", baseUrl: `${FAKE}/v1` });
  const m = await api("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "qwen3:8b", displayName: "Qwen3 8B", sections: ["chat", "work", "code"] });
  await api("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id });
});

/* ═════════════ Workspaces and the IDE ═════════════ */
await step("Code", "Code home: empty state and explanation", async () => {
  await page.goto(`${APP}/app/code`);
  await page.getByText("No workspaces yet").waitFor();
  await page.getByText("Aatmiq panel", { exact: true }).waitFor();
  await page.screenshot({ path: `${OUT}code-home-empty.png` });
});
await step("Code", "Create a workspace; the IDE opens inside Aatmiq", async () => {
  await page.getByTestId("new-code-workspace").click();
  await page.getByTestId("code-workspace-name").fill("Billing service");
  await page.getByTestId("create-code-workspace").click();
  await page.waitForURL(/\/app\/code\/[\w-]+$/);
  await ide().locator(".monaco-workbench").waitFor({ timeout: 40000 });
  await ide().locator(".explorer-folders-view, .explorer-viewlet").first().waitFor();
  await page.locator("aside").getByText("Billing service").waitFor();
  const frame = page.frames().find((f) => f.url().includes("/code/ide"));
  expect(/Aatmiq Code/.test((await frame?.title()) ?? ""), `title: ${await frame?.title()}`);
  if (IDE_URL) expect(frame.url().startsWith(`${IDE_URL}/code/ide`), `IDE frame at ${frame.url()}`);
});
if (IDE_URL)
  await step("Code", "On its own host the IDE can't reach Aatmiq, and a new tab gets a fresh link", async () => {
    const frame = page.frames().find((f) => f.url().startsWith(`${IDE_URL}/code/ide`));
    // From inside the IDE (where extensions run): Aatmiq's API is another origin and refuses.
    const read = await frame.evaluate((app) => fetch(`${app}/api/me`, { credentials: "include" }).then((r) => r.status, () => "blocked"), APP);
    expect(read === "blocked", `reading Aatmiq from the IDE: ${read}`);
    const write = await frame.evaluate((app) => fetch(`${app}/api/me`, { method: "PATCH", credentials: "include", headers: { "content-type": "application/json" }, body: "{}" }).then((r) => r.status, () => "blocked"), APP);
    expect(write === "blocked", `changing Aatmiq from the IDE: ${write}`);
    const own = await frame.evaluate(() => fetch("/api/me").then((r) => r.status));
    expect(own === 404, `the IDE host's own /api: ${own}`);
    // The browser logs the refused requests above (the IDE's CSP); they're what this step expects.
    for (let i = consoleErrors.length - 1; i >= 0; i--) if (consoleErrors[i].includes(`${APP}/api/me`)) consoleErrors.splice(i, 1);
    const [tab] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("open-ide-tab").click()]);
    await tab.waitForURL((u) => u.href.startsWith(`${IDE_URL}/code/ide`));
    await tab.locator(".monaco-workbench").waitFor({ timeout: 40000 });
    await tab.close();
  });
await step("Code", "The terminal runs as the person, with their Git identity", async () => {
  await ide().locator(".monaco-workbench").click({ position: { x: 700, y: 400 } });
  await page.keyboard.press("Control+Backquote");
  await ide().locator(".xterm").first().waitFor();
  await page.waitForTimeout(1500);
  await ide().locator(".xterm").first().click();
  await page.keyboard.type('echo "$(whoami) | $(git var GIT_AUTHOR_IDENT | cut -d">" -f1)>" > who.txt\n');
  await explorer().getByText("who.txt").waitFor();
  await page.screenshot({ path: `${OUT}ide-terminal.png` });
});

/* ═════════════ Aatmiq panel ═════════════ */
await step("Panel", "The Aatmiq panel is open on the right and knows the workspace", async () => {
  await panel().getByText("What should we build?").waitFor({ timeout: 30000 });
  await panel().getByText("Billing service").first().waitFor();
});
await step("Panel", "Ask the agent to create a file; it appears in the editor", async () => {
  await panel().locator("#input").fill("write notes.md: # Billing notes");
  await panel().locator("[data-send]").click();
  await panel().locator(".step", { hasText: "Wrote" }).waitFor();
  await panel().locator(".answer", { hasText: "Done. The tool returned" }).waitFor({ timeout: 30000 });
  await explorer().getByText("notes.md").waitFor();
  await page.screenshot({ path: `${OUT}panel-done.png` });
});
await step("Panel", "A delete waits for approval in the panel; approving removes the file", async () => {
  await panel().locator("#input").fill("run: rm who.txt");
  await panel().locator("[data-send]").click();
  const card = panel().locator(".approval");
  await card.getByText("Deletes files").waitFor({ timeout: 30000 });
  await card.getByText("rm who.txt").waitFor();
  await page.screenshot({ path: `${OUT}panel-approval.png` });
  await card.getByText("Approve").click();
  await panel().locator(".note", { hasText: "Approved" }).waitFor();
  await waitFor(async () => (await explorer().getByText("who.txt").count()) === 0);
});
await step("Panel", "Steps open their file in the editor", async () => {
  const step = panel().locator(".step", { hasText: "Wrote" }).first();
  await step.locator("summary").hover();
  await step.locator("[data-open]").click();
  await ide().locator(".tab", { hasText: "notes.md" }).waitFor();
  // Let the editor finish reading the file; leaving mid-read logs a "Canceled" error.
  await ide().locator(".view-lines", { hasText: "Billing notes" }).waitFor();
});

/* ═════════════ Git ═════════════ */
await step("Git", "Clone a repository into a new workspace and open it", async () => {
  await page.goto(`${APP}/app/code`);
  await page.getByTestId("new-code-workspace").click();
  await page.getByTestId("code-git-url").fill("http://localhost:11700/invoices.git");
  expect((await page.getByTestId("code-workspace-name").inputValue()) === "invoices", "name from URL");
  await page.getByTestId("create-code-workspace").click();
  const card = page.getByTestId("code-workspace").filter({ hasText: "invoices" });
  await card.getByText(/Not opened yet/).waitFor({ timeout: 30000 });
  await card.click();
  await page.waitForURL(/\/app\/code\/[\w-]+$/);
  await explorer().getByText("invoices.py").waitFor({ timeout: 40000 });
  await page.screenshot({ path: `${OUT}ide-cloned.png` });
});
await step("Git", "Agent edits show up as changed files with a diff", async () => {
  await panel().locator("#input").fill("run: echo '# changed by the agent' >> README.md");
  await panel().locator("[data-send]").click();
  await panel().locator(".changes").getByText("README.md").waitFor({ timeout: 30000 });
  await panel().locator("[data-diff='README.md']").click();
  await ide().locator(".tab", { hasText: "README.md (changes)" }).first().waitFor();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}panel-diff.png` });
});
await step("Git", "A failed clone says why", async () => {
  const r = await api("POST", "/api/code/workspaces", { workspaceId: (await api("GET", "/api/me")).json.workspaces[0].id, name: "missing", gitUrl: "http://localhost:11700/nope.git" });
  expect(r.status === 200 && r.json.status === "cloning", "clone started");
  await page.goto(`${APP}/app/code`);
  await page.getByTestId("code-workspace").filter({ hasText: "missing" }).getByText(/not found|fatal|failed/i).waitFor({ timeout: 30000 });
});

/* ═════════════ Manage ═════════════ */
await step("Manage", "Rename and delete workspaces", async () => {
  await page.goto(`${APP}/app/code`);
  const card = page.getByTestId("code-workspace").filter({ hasText: "missing" });
  await card.hover();
  await card.getByLabel("Options for missing").click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.click('[role="dialog"] >> button:has-text("Delete workspace")');
  await page.locator("[data-sonner-toast]", { hasText: "Workspace deleted" }).waitFor();
  const billing = page.getByTestId("code-workspace").filter({ hasText: "Billing service" });
  await billing.hover();
  await billing.getByLabel("Options for Billing service").click();
  await page.getByRole("menuitem", { name: "Rename" }).click();
  await page.fill('[role="dialog"] input', "Billing API");
  await page.click('[role="dialog"] >> button:has-text("Save")');
  await page.getByTestId("code-workspace").filter({ hasText: "Billing API" }).waitFor();
  expect((await page.getByTestId("code-workspace").count()) === 2, "two left");
  await page.screenshot({ path: `${OUT}code-home.png` });
});
await step("Manage", "Signed out, the IDE is not reachable", async () => {
  const anon = await browser.newContext();
  if (IDE_URL) {
    const p = await anon.newPage();
    const r = await p.goto(`${IDE_URL}/code/ide/`);
    expect(r.status() === 401, `IDE host status ${r.status()}`);
    await p.getByText("Open your workspace from Aatmiq").waitFor();
    const moved = await anon.request.get(`${APP}/code/ide/`);
    expect(moved.status() === 404, `app host status ${moved.status()}`);
  } else {
    const r = await anon.request.get(`${APP}/code/ide/`);
    expect(r.status() === 401, `status ${r.status()}`);
  }
  await anon.close();
});

/* ═════════════ Report ═════════════ */
await browser.close();
gitServer.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} [${r.area}] ${r.name}${r.ok ? "" : `\n      ${r.err}`}`);
if (failedRequests.length) console.log(`\nFailed requests (${failedRequests.length}):\n${failedRequests.slice(0, 12).join("\n")}`);
if (consoleErrors.length) console.log(`\nConsole errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 15).join("\n")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
