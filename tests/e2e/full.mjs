/**
 * Full browser test of everything built so far. Each step is independent: failures are
 * recorded with a screenshot and the run continues.
 */
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const FAKE = process.env.FAKE_LLM_URL ?? "http://localhost:11500";
const OUT = new URL("./results/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const results = [];
const consoleErrors = [];
let n = 0;

async function newUser(tag, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport, permissions: ["clipboard-read", "clipboard-write"], acceptDownloads: true });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (401|402|403|404|409|415)/.test(m.text())) consoleErrors.push(`[${tag}] ${m.text()}`);
  });
  page.on("pageerror", (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
  page.setDefaultTimeout(10000);
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
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** Wait until a new assistant reply has finished streaming (count grew, no Stop button). */
async function waitReply(page, before) {
  await page.waitForFunction(
    (b) => document.querySelectorAll(".prose-chat").length > b && !document.querySelector('button[aria-label="Stop"]'),
    before,
    { timeout: 25000 },
  );
  await wait(300);
}
async function send(page, text) {
  const before = await page.locator(".prose-chat").count();
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
  await waitReply(page, before);
}
const assistantCount = (page) => page.locator(".prose-chat").count();
async function toast(page, text) {
  await page.locator("[data-sonner-toast]", { hasText: text }).first().waitFor({ timeout: 10000 });
}

/* ═════════════ A. Public pages ═════════════ */
const { page: pub } = await newUser("public");

await step("Public", "Landing page renders hero, sections and plans", pub, async () => {
  await pub.goto(BASE);
  await pub.getByRole("heading", { name: /Your own AI/ }).waitFor();
  for (const t of ["Everything your team uses AI for", "Nothing leaves your building", "Control who uses what", "Start with chat"])
    expect(await pub.getByText(t).count(), `missing section: ${t}`);
});
await step("Public", "Nav anchor scrolls to Privacy section", pub, async () => {
  await pub.click("header >> text=Privacy");
  await wait(800);
  expect((await pub.evaluate(() => window.scrollY)) > 500, "did not scroll");
});
await step("Public", "Invalid invite link shows a friendly error", pub, async () => {
  await pub.goto(`${BASE}/invite/not-a-real-token`);
  await pub.getByText("Invitation not valid").waitFor();
});
await step("Public", "Sign in on a fresh install redirects to setup", pub, async () => {
  await pub.goto(`${BASE}/login`);
  await pub.waitForURL("**/setup");
});
await step("Public", "Protected page redirects to sign-in", pub, async () => {
  await pub.goto(`${BASE}/app/chat`);
  await pub.waitForURL(/\/(login|setup)/);
});

/* ═════════════ B. Setup ═════════════ */
const { page: owner } = await newUser("owner");
await step("Setup", "Wizard step 1 → accent colour preview → step 2", owner, async () => {
  await owner.goto(`${BASE}/setup`);
  await owner.fill('input[placeholder="Acme Labs"]', "Acme Labs");
  await owner.click('button[aria-label="Accent #A78BFA"]');
  const accent = await owner.evaluate(() => document.documentElement.style.getPropertyValue("--accent"));
  expect(accent.toLowerCase() === "#a78bfa", `accent preview not applied (${accent})`);
  await owner.click('button[aria-label="Accent #22D3EE"]');
  await owner.click("text=Continue");
  await owner.getByText("Create the owner account").waitFor();
});
await step("Setup", "Short password is rejected by the form", owner, async () => {
  await owner.fill('input[placeholder="Asha Rao"]', "Asha Rao");
  await owner.fill('input[type="email"]', "asha@acme.test");
  await owner.fill('input[type="password"]', "short");
  await owner.click("text=Create workspace");
  await wait(500);
  expect(owner.url().includes("/setup"), "submitted with short password");
});
await step("Setup", "Back button returns to step 1 keeping values", owner, async () => {
  await owner.click("button:has-text('Back')");
  expect((await owner.inputValue('input[placeholder="Acme Labs"]')) === "Acme Labs", "org name lost");
  await owner.click("text=Continue");
});
await step("Setup", "Completing setup signs the owner in", owner, async () => {
  await owner.fill('input[type="password"]', "correct-horse-battery");
  await owner.click("text=Create workspace");
  await owner.waitForURL("**/app/chat");
  await owner.getByRole("heading", { name: /, Asha/ }).waitFor();
  await owner.screenshot({ path: `${OUT}setup-done.png` });
});
await step("Setup", "Setup page is closed after setup", pub, async () => {
  await pub.goto(`${BASE}/setup`);
  await pub.waitForURL("**/login");
  await pub.getByRole("heading", { name: "Sign in to Aatmiq" }).waitFor();
});

/* ═════════════ C. Chat basics (demo model) ═════════════ */
await step("Chat", "Quick action fills the composer; sending streams a reply", owner, async () => {
  await owner.click("button:has-text('Draft an email')");
  expect((await owner.locator("textarea").inputValue()) === "Draft a polite email to ", "quick action did not fill composer");
  await owner.locator("textarea").pressSequentially("Acme about the overdue invoice");
  await owner.keyboard.press("Enter");
  await waitReply(owner, 0);
  expect((await assistantCount(owner)) === 1, "no assistant reply");
  expect(owner.url().match(/\/app\/chat\/[\w-]+$/), "URL not updated to chat id");
});
await step("Chat", "New chat appears in sidebar with an auto title", owner, async () => {
  await owner.locator('aside a[href^="/app/chat/"]', { hasText: "Draft a polite email to Acme" }).waitFor();
});
await step("Chat", "Shift+Enter inserts a newline instead of sending", owner, async () => {
  const ta = owner.locator("textarea");
  await ta.fill("line one");
  await ta.press("Shift+Enter");
  await ta.type("line two");
  expect((await ta.inputValue()).includes("\n"), "no newline");
  await ta.press("Enter");
  await waitReply(owner, 1);
  expect((await assistantCount(owner)) === 2, "second reply missing");
});
await step("Chat", "Copy button copies the reply", owner, async () => {
  await owner.locator('button[aria-label="Copy"]').last().click();
  const clip = await owner.evaluate(() => navigator.clipboard.readText());
  expect(clip.includes("Aatmiq demo model"), "clipboard empty");
});
await step("Chat", "Code block copy button works", owner, async () => {
  await owner.locator("button:has-text('Copy')").last().click();
  await owner.getByText("Copied").first().waitFor();
});
await step("Chat", "Regenerate adds a new version of the reply", owner, async () => {
  await owner.click('button[aria-label="Regenerate"]');
  await owner.getByTestId("branch-nav").filter({ hasText: "2/2" }).waitFor();
  await owner.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 20000 });
  expect((await assistantCount(owner)) === 2, `expected 2 replies shown, got ${await assistantCount(owner)}`);
});
let firstChatUrl = owner.url();
await step("Chat", "Reloading a chat URL restores the conversation", owner, async () => {
  firstChatUrl = owner.url();
  await owner.reload();
  await owner.locator(".prose-chat").nth(1).waitFor();
  await owner.getByTestId("branch-nav").filter({ hasText: "2/2" }).waitFor();
});
await step("Chat", "New chat button opens an empty chat", owner, async () => {
  await owner.click("aside >> text=New chat");
  await owner.waitForURL("**/app/chat");
  await owner.getByText("where should we start today?").waitFor();
  await send(owner, "Second conversation about budgets");
});
await step("Chat", "Clicking a chat in the sidebar opens it", owner, async () => {
  await owner.locator("aside a", { hasText: "Draft a polite email to Acme" }).click();
  await owner.waitForURL(firstChatUrl);
  await owner.locator(".prose-chat").nth(1).waitFor();
});
await step("Chat", "Rename a chat", owner, async () => {
  const row = owner.locator("aside div.group", { hasText: "Second conversation" });
  await row.hover();
  await row.locator('button[aria-label="Chat options"]').click();
  await owner.getByRole("menuitem", { name: "Rename" }).click();
  await owner.locator('[role="dialog"] input').fill("Budget planning");
  await owner.click('[role="dialog"] >> text=Save');
  await owner.locator("aside a", { hasText: "Budget planning" }).waitFor();
});
await step("Chat", "Pin a chat moves it under Pinned", owner, async () => {
  const row = owner.locator("aside div.group", { hasText: "Budget planning" });
  await row.hover();
  await row.locator('button[aria-label="Chat options"]').click();
  await owner.getByRole("menuitem", { name: "Pin" }).click();
  await owner.locator("aside >> text=Pinned").waitFor();
});
await step("Chat", "⌘K search finds chats by title and message text", owner, async () => {
  await owner.keyboard.press("Control+k");
  await owner.getByTestId("search-input").fill("budget");
  await owner.locator('[role="dialog"] button', { hasText: "Budget planning" }).waitFor();
  // Matches inside messages, with a snippet.
  await owner.getByTestId("search-input").fill("polite");
  await owner.locator('[role="dialog"] button', { hasText: "Draft a polite email" }).first().waitFor();
  await owner.getByTestId("search-input").fill("budget");
  await wait(400);
  await owner.keyboard.press("Enter");
  await owner.waitForURL(/\/app\/chat\/.+/);
  await owner.locator(".prose-chat").first().waitFor();
});
await step("Chat", "Delete a chat", owner, async () => {
  const row = owner.locator("aside div.group", { hasText: "Budget planning" });
  await row.hover();
  await row.locator('button[aria-label="Chat options"]').click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  await wait(600);
  expect((await owner.locator("aside a", { hasText: "Budget planning" }).count()) === 0, "still listed");
});
await step("Chat", "Sidebar collapses with button and Ctrl+B", owner, async () => {
  await owner.click('button[aria-label="Collapse sidebar"]');
  await owner.locator('button[aria-label="Open sidebar"]').waitFor();
  await owner.keyboard.press("Control+b");
  await owner.locator('button[aria-label="Collapse sidebar"]').waitFor();
});
await step("Chat", "Work AI and Code preview pages open", owner, async () => {
  await owner.click("aside a:has-text('Work AI')");
  await owner.getByText("Implementation plan").waitFor();
  await owner.click("aside a:has-text('Code')");
  await owner.getByText("invoices.ts").first().waitFor();
});

/* ═════════════ D. Models & providers ═════════════ */
await step("Models", "Add an Ollama provider (reachable)", owner, async () => {
  await owner.goto(`${BASE}/admin/models`);
  await owner.click("text=Add provider");
  await owner.locator('[role="dialog"] input').nth(1).fill(FAKE);
  await owner.click('[role="dialog"] >> button:has-text("Connect")');
  await toast(owner, "Provider connected");
  await owner.getByText(/Healthy · \d+ms/).first().waitFor();
});
await step("Models", "Discover models from the provider and add two", owner, async () => {
  await owner.click("text=Add models from Ollama");
  await owner.getByText("qwen3:8b").waitFor();
  const add = async (key) => {
    const row = owner.locator('[role="dialog"] div.border-b', { hasText: key });
    await row.getByRole("button", { name: "Add" }).click();
    await row.getByText("Added").waitFor();
  };
  await add("qwen3:8b");
  await add("deepseek-v4:32b");
});
await step("Models", "Add a model by name", owner, async () => {
  await owner.fill('input[placeholder="e.g. deepseek-v4:32b"]', "gemma3:12b");
  await owner.locator('[role="dialog"] button:has-text("Add")').last().click();
  await wait(700);
  await owner.keyboard.press("Escape");
  await owner.getByText("gemma3:12b").first().waitFor();
  expect((await owner.locator("tbody tr").count()) === 5, `expected 5 models (incl. demo embeddings), got ${await owner.locator("tbody tr").count()}`);
});
await step("Models", "Unreachable provider is added with a clear error", owner, async () => {
  await owner.click("text=Add provider");
  await owner.click('[role="dialog"] >> text=OpenAI-compatible');
  await owner.locator('[role="dialog"] input').nth(0).fill("Broken vLLM");
  await owner.locator('[role="dialog"] input').nth(1).fill("http://127.0.0.1:1/v1");
  await owner.locator('[role="dialog"] input[type="password"]').fill("sk-test");
  await owner.click('[role="dialog"] >> button:has-text("Connect")');
  await toast(owner, "isn't reachable");
  await owner.locator("span.font-medium", { hasText: "Broken vLLM" }).waitFor();
  await owner.getByText("Provider returned").first().count();
});
await step("Models", "Test connection and remove the broken provider", owner, async () => {
  const card = owner.locator("div.rounded-xl", { hasText: "Broken vLLM" }).last();
  await card.locator('button[aria-label="Provider actions"]').click();
  await owner.getByRole("menuitem", { name: "Test connection" }).click();
  await wait(800);
  await card.locator('button[aria-label="Provider actions"]').click();
  await owner.getByRole("menuitem", { name: "Remove provider" }).click();
  await wait(800);
  expect((await owner.getByText("Broken vLLM").count()) === 0, "provider still shown");
});
await step("Models", "Section toggle and enable switch persist", owner, async () => {
  const row = owner.locator("tbody tr", { hasText: "gemma3:12b" });
  await row.locator("button:has-text('Code')").click();
  await row.locator('button[role="switch"]').click();
  await wait(700);
  await owner.reload();
  const r2 = owner.locator("tbody tr", { hasText: "gemma3:12b" });
  await r2.waitFor();
  expect((await r2.locator('button[role="switch"]').getAttribute("data-state")) === "unchecked", "still enabled");
  expect(((await r2.locator("button:has-text('Code')").getAttribute("class")) ?? "").includes("text-fg-subtle"), "Code still on");
});

/* ═════════════ E. Workspace models & routing ═════════════ */
let generalId = "";
await step("Workspaces", "Enable models for General and set default", owner, async () => {
  await owner.goto(`${BASE}/admin/workspaces`);
  await owner.locator('a[href^="/admin/workspaces/"]', { hasText: "General" }).click();
  await owner.waitForURL(/admin\/workspaces\/[\w-]{20,}$/);
  generalId = owner.url().split("/").pop();
  await owner.click("button:has-text('Models')");
  const mrow = (m) => owner.locator("div.gap-4", { hasText: m });
  for (const m of ["Qwen3 8B", "Deepseek V4 32B"]) await mrow(m).getByRole("switch").click();
  await mrow("Qwen3 8B").getByRole("button", { name: "Make default" }).click();
  await owner.click("button:has-text('Save changes')");
  await toast(owner, "Models updated");
});
await step("Chat", "Model picker lists workspace models and routes to the chosen one", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.locator("button", { hasText: "Qwen3 8B" }).first().waitFor();
  await owner.locator("form button", { hasText: "Qwen3 8B" }).click();
  await owner.getByRole("menuitem", { name: /Deepseek V4 32B/ }).click();
  await send(owner, "Which model are you?");
  await owner.locator(".prose-chat", { hasText: "deepseek-v4:32b" }).waitFor();
});
await step("Chat", "Stop button halts a long reply and keeps partial text", owner, async () => {
  await owner.locator("textarea").fill("please be slow");
  await owner.keyboard.press("Enter");
  await owner.locator(".prose-chat", { hasText: "word5" }).waitFor();
  await owner.locator('button[aria-label="Stop"]').click({ timeout: 5000 });
  await owner.waitForSelector('button[aria-label="Send"]');
  await wait(500);
  const text = await owner.locator(".prose-chat").last().innerText();
  expect(text.includes("word1") && !text.includes("word199"), `not partial: ${text.slice(-40)}`);
});

/* ═════════════ D2. Documents ═════════════ */
const fixture = (n) => new URL(`../../apps/api/test/fixtures/${n}`, import.meta.url).pathname;
const docRow = (page, name) => page.locator("div.group", { hasText: name }).first();

await step("Documents", "Upload a PDF on the Documents page; it becomes ready", owner, async () => {
  await owner.goto(`${BASE}/app/documents`);
  await owner.getByText("Drop files here or click to upload").waitFor();
  await owner.locator('[data-testid="doc-upload"]').setInputFiles(fixture("report.pdf"));
  await docRow(owner, "report.pdf").getByText("Ready").waitFor({ timeout: 15000 });
  await docRow(owner, "report.pdf").getByText("2 pages").waitFor();
});
await step("Documents", "Unsupported files are rejected with a clear message", owner, async () => {
  await owner.locator('[data-testid="doc-upload"]').setInputFiles({ name: "movie.mp4", mimeType: "video/mp4", buffer: Buffer.from("x") });
  await toast(owner, "isn't supported");
});
await step("Documents", "Ask about a document: cited answer and source preview", owner, async () => {
  await docRow(owner, "report.pdf").getByRole("button", { name: "Ask" }).click();
  await owner.waitForURL(/\/app\/chat\?doc=/);
  await owner.locator("form span", { hasText: "report.pdf" }).first().waitFor();
  await send(owner, "How much did revenue grow?");
  await owner.locator('button[data-cite="1"]').first().waitFor();
  await owner.getByText("Sources").waitFor();
  await owner.locator('button[data-cite="1"]').first().click();
  await owner.locator('[role="dialog"]', { hasText: "revenue grew 18 percent" }).waitFor();
  await owner.keyboard.press("Escape");
  await owner.getByText("1 document").waitFor();
});
await step("Documents", "Composer: + uploads a file and @ attaches one from the library", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.locator('[data-testid="composer-upload"]').setInputFiles(fixture("policy.docx"));
  await owner.locator("form span", { hasText: "policy.docx" }).first().waitFor();
  await owner.click('button[aria-label="Attach a document"]');
  await owner.locator('[role="dialog"] button', { hasText: "report.pdf" }).click();
  await owner.locator("form span", { hasText: "report.pdf" }).first().waitFor();
  await owner.waitForFunction(() => !document.querySelector("form .animate-spin"), null, { timeout: 15000 });
  await send(owner, "What is the travel policy for short flights?");
  await owner.getByText("2 documents").waitFor();
  const userCard = await owner.locator("main .bg-surface-2", { hasText: "What is the travel policy" }).first().innerText();
  expect(userCard.includes("policy.docx") && userCard.includes("report.pdf"), "attachments not shown on message");
  await owner.locator('button[data-cite="1"]').first().waitFor();
});
await step("Documents", "Share a document with the workspace", owner, async () => {
  await owner.goto(`${BASE}/app/documents`);
  await docRow(owner, "report.pdf").locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Share with workspace" }).click();
  await docRow(owner, "report.pdf").getByText("Workspace", { exact: true }).waitFor();
});
await step("Documents", "Delete a document after confirming", owner, async () => {
  await owner.locator('[data-testid="doc-upload"]').setInputFiles({ name: "old-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Old meeting notes") });
  await docRow(owner, "old-notes.txt").getByText("Ready").waitFor({ timeout: 15000 });
  await docRow(owner, "old-notes.txt").locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Delete" }).click();
  await owner.click('[role="dialog"] >> button:has-text("Delete document")');
  await toast(owner, "Document deleted");
  expect((await owner.getByText("old-notes.txt").count()) === 0, "still listed");
});

/* ═════════════ F. Workspaces ═════════════ */
await step("Workspaces", "Create a workspace; creator becomes its admin", owner, async () => {
  await owner.goto(`${BASE}/admin/workspaces`);
  await owner.click("text=New workspace");
  await owner.fill('input[placeholder="Engineering"]', "Engineering");
  await owner.click('[role="dialog"] >> button:has-text("Create")');
  await owner.locator('a[href^="/admin/workspaces/"]', { hasText: "Engineering" }).waitFor();
});
await step("Workspaces", "Switch to the new workspace; it has no models yet", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.locator("aside button", { hasText: "General" }).first().click();
  await owner.getByRole("menuitem", { name: /Engineering/ }).click();
  await owner.getByText("No models are enabled in this workspace").waitFor();
  await owner.locator("aside button", { hasText: "Engineering" }).first().click();
  await owner.getByRole("menuitem", { name: /General/ }).click();
});
await step("Workspaces", "Rename and archive a workspace", owner, async () => {
  await owner.goto(`${BASE}/admin/workspaces`);
  await owner.locator('a[href^="/admin/workspaces/"]', { hasText: "Engineering" }).click();
  await owner.click("button:has-text('Settings')");
  await owner.locator("input").first().fill("Engineering Team");
  await owner.click("button:has-text('Save')");
  await owner.getByText("Engineering Team").first().waitFor();
  await owner.click("button:has-text('Archive')");
  await owner.click('[role="dialog"] >> button:has-text("Archive workspace")');
  await owner.waitForURL("**/admin/workspaces");
  await wait(600);
  expect((await owner.getByText("Engineering Team").count()) === 0, "still listed");
});

/* ═════════════ G. Users & invitations ═════════════ */
async function invite(email, wsRole = "member", orgRole = "member") {
  await owner.goto(`${BASE}/admin/users`);
  await owner.click("text=Invite people");
  await owner.fill('input[placeholder="name@company.com"]', email);
  if (orgRole === "admin") await owner.locator('[role="dialog"] select').first().selectOption("admin");
  await owner.locator('[role="dialog"] input[type="checkbox"]').first().check();
  if (wsRole === "admin") await owner.locator('[role="dialog"] select').last().selectOption("admin");
  await owner.click("text=Create invitation");
  await owner.locator('[role="dialog"] code').waitFor();
  const link = await owner.locator('[role="dialog"] code').innerText();
  await owner.click('[role="dialog"] >> text=Done');
  return link;
}
let devLink = "", wandaLink = "";
await step("Users", "Invite a member and get a copyable link", owner, async () => {
  devLink = await invite("dev@acme.test");
  expect(devLink.includes("/invite/"), "no link");
});
await step("Users", "Invite a workspace admin", owner, async () => {
  wandaLink = await invite("wanda@acme.test", "admin");
});
await step("Users", "Revoke a pending invitation", owner, async () => {
  await invite("temp@acme.test");
  await owner.goto(`${BASE}/admin/users`);
  const row = owner.locator("div.flex", { hasText: "temp@acme.test" }).last();
  await row.locator("button:has-text('Revoke')").click();
  await wait(600);
  expect((await owner.getByText("temp@acme.test").count()) === 0, "still pending");
  expect((await owner.getByText("dev@acme.test").count()) >= 1, "dev invite missing");
});
await step("Users", "Inviting an existing user is refused", owner, async () => {
  await owner.click("text=Invite people");
  await owner.fill('input[placeholder="name@company.com"]', "asha@acme.test");
  await owner.click("text=Create invitation");
  await toast(owner, "already exists");
  await owner.keyboard.press("Escape");
});

/* ═════════════ H. Member ═════════════ */
const { page: dev, ctx: devCtx } = await newUser("dev");
await step("Member", "Accept invite: short password blocked, then joins", dev, async () => {
  await dev.goto(devLink);
  await dev.getByText("Join Acme Labs").waitFor();
  await dev.fill('input[placeholder="Full name"]', "Dev Kumar");
  await dev.fill('input[type="password"]', "short");
  await dev.click("text=Join workspace");
  await wait(400);
  expect(dev.url().includes("/invite/"), "accepted short password");
  await dev.fill('input[type="password"]', "another-good-password");
  await dev.click("text=Join workspace");
  await dev.waitForURL("**/app/chat");
});
await step("Member", "Used invite link no longer works", pub, async () => {
  await pub.goto(devLink);
  await pub.getByText("Invitation not valid").waitFor();
});
await step("Member", "Member cannot open the admin console", dev, async () => {
  expect((await dev.getByText("Admin console").count()) === 0, "admin menu visible");
  await dev.goto(`${BASE}/admin/users`);
  await dev.waitForURL("**/app/chat");
});
await step("Member", "Member chats with the workspace default model", dev, async () => {
  await dev.locator("form button", { hasText: "Qwen3 8B" }).waitFor();
  await send(dev, "hello from dev");
  await dev.locator(".prose-chat", { hasText: "qwen3:8b" }).waitFor();
});
await step("Member", "Chats are private: owner can't open Dev's chat", owner, async () => {
  const devChat = dev.url();
  await owner.goto(devChat);
  await wait(1500);
  expect((await owner.locator(".prose-chat", { hasText: "hello from dev" }).count()) === 0, "owner saw dev chat");
});
await step("Member", "Profile changes persist", dev, async () => {
  await dev.goto(`${BASE}/app/settings`);
  await dev.fill('input[placeholder="e.g. Finance lead"]', "Backend engineer");
  await dev.fill("textarea", "Prefer TypeScript examples.");
  await dev.click("text=Save changes");
  await dev.getByText("Profile saved").waitFor();
  await dev.reload();
  expect((await dev.inputValue('input[placeholder="e.g. Finance lead"]')) === "Backend engineer", "not saved");
});
await step("Member", "Light theme applies and persists", dev, async () => {
  await dev.click("button:has-text('Appearance')");
  await dev.click("button:has-text('Light')");
  expect((await dev.evaluate(() => document.documentElement.dataset.theme)) === "light", "not light");
  await dev.reload();
  expect((await dev.evaluate(() => document.documentElement.dataset.theme)) === "light", "not persisted");
  await dev.screenshot({ path: `${OUT}member-light-settings.png` });
  await dev.click("button:has-text('Appearance')");
  await dev.click("button:has-text('Dark')");
});
await step("Member", "Member sees shared documents but not private ones", dev, async () => {
  await dev.goto(`${BASE}/app/documents`);
  await dev.getByText("report.pdf").waitFor();
  expect((await dev.getByText("policy.docx").count()) === 0, "private doc visible to member");
  await dev.locator('button[aria-label^="Actions for"]').first().click();
  expect((await dev.getByRole("menuitem", { name: "Delete" }).count()) === 0, "member can delete owner's doc");
  await dev.keyboard.press("Escape");
});
/* ═════════════ H2. Projects ═════════════ */
let projectUrl = "";
let projectChatUrl = "";
await step("Projects", "Create a project with instructions from the sidebar", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.click('aside button[aria-label="New project"]');
  await owner.fill('[role="dialog"] input', "Launch plan");
  await owner.fill('[role="dialog"] textarea', "Reply in one short paragraph.");
  await owner.click('[role="dialog"] >> text=Create project');
  await owner.waitForURL(/\/app\/projects\/[^/]+$/);
  projectUrl = owner.url();
  await owner.getByTestId("project-title").filter({ hasText: "Launch plan" }).waitFor();
  await owner.getByTestId("instructions-preview").filter({ hasText: "one short paragraph" }).waitFor();
  await owner.locator("aside a", { hasText: "Launch plan" }).waitFor();
});
await step("Projects", "Add pasted text as a source; it becomes ready", owner, async () => {
  await owner.click('button[aria-label="Add source"]');
  await owner.getByRole("menuitem", { name: "Add text" }).click();
  await owner.fill('[role="dialog"] input', "Launch facts");
  await owner.getByTestId("note-body").fill("The launch date is 12 November. The venue is Hall B in Pune.");
  await owner.click('[role="dialog"] >> text=Add source');
  await owner.getByTestId("project-sources").getByText("Launch facts.md").waitFor();
  await owner.waitForFunction(() => !document.querySelector('[data-testid="project-sources"] [aria-label="Processing"]'), null, { timeout: 15000 });
});
await step("Projects", "Upload a file as a project source", owner, async () => {
  await owner.getByTestId("project-upload").setInputFiles(fixture("policy.docx"));
  await owner.getByTestId("project-sources").getByText("policy.docx").waitFor();
  await owner.waitForFunction(() => !document.querySelector('[data-testid="project-sources"] [aria-label="Processing"]'), null, { timeout: 15000 });
  // Project files don't clutter the Documents library.
  await owner.goto(`${BASE}/app/documents`);
  await owner.locator("h1", { hasText: "Documents" }).waitFor();
  await wait(800);
  expect((await owner.getByText("Launch facts.md").count()) === 0, "project note appears in library");
  await owner.goto(projectUrl);
});
await step("Projects", "Project chat uses sources and instructions without attaching", owner, async () => {
  await owner.getByTestId("project-title").waitFor();
  await send(owner, "When is the launch?");
  await owner.waitForURL(/\/app\/projects\/[^/]+\/[^/]+$/);
  projectChatUrl = owner.url();
  await owner.locator(".prose-chat", { hasText: "Following the project instructions" }).waitFor();
  await owner.locator("button", { hasText: "Launch facts.md" }).first().waitFor();
  await owner.locator("header a", { hasText: "Launch plan" }).waitFor();
  expect((await owner.locator("aside a", { hasText: "When is the launch?" }).count()) === 0, "project chat in Recents");
});
await step("Projects", "Save an answer to the project's sources", owner, async () => {
  await owner.click('button[aria-label="Save to project"]');
  await toast(owner, "Saved to Launch plan sources");
  await owner.locator("header a", { hasText: "Launch plan" }).click();
  await owner.getByTestId("project-sources").getByText(/When is the launch\? \(answer/).waitFor();
});
await step("Projects", "Chats in a project remember each other", owner, async () => {
  await owner.getByTestId("project-title").waitFor();
  await send(owner, "Note for later: the sponsor code is ZETA-7781");
  await owner.locator("header").getByRole("button", { name: "New", exact: true }).click();
  await owner.getByTestId("project-title").waitFor();
  await send(owner, "What was the sponsor code ZETA-7781 about?");
  await owner.locator("button", { hasText: "Note for later: the sponsor code" }).first().waitFor();
  await owner.locator("button", { hasText: "Note for later: the sponsor code" }).first().click();
  await owner.locator('[role="dialog"]', { hasText: "earlier chat in this project" }).waitFor();
  await owner.keyboard.press("Escape");
});
await step("Projects", "Share the project with a member who can chat", owner, async () => {
  await owner.goto(projectUrl);
  await owner.click("button:has-text('Share')");
  await owner.locator('[role="dialog"] select[aria-label="Person to add"]').selectOption({ label: "Dev Kumar · dev@acme.test" });
  await owner.click('[role="dialog"] >> button:has-text("Add")');
  await owner.locator('[role="dialog"]', { hasText: "dev@acme.test" }).locator('select[aria-label="Role for Dev Kumar"]').waitFor();
  await owner.keyboard.press("Escape");
});
await step("Projects", "Member sees instructions and sources, not private chats", dev, async () => {
  await dev.goto(`${BASE}/app/chat`);
  await dev.locator("aside a", { hasText: "Launch plan" }).click();
  await dev.getByTestId("project-title").waitFor();
  await dev.getByTestId("instructions-preview").waitFor();
  await dev.getByTestId("project-sources").getByText("Launch facts.md").waitFor();
  expect((await dev.locator('button[aria-label="Add source"]').count()) === 0, "chat-role member can add sources");
  // Asha's chats are private until shared (her saved answer, a source, is visible though).
  expect((await dev.getByTestId("project-chats").count()) === 0, "member sees owner's private chat");
});
await step("Projects", "Owner shares a chat; member reads it read-only", owner, async () => {
  await owner.goto(projectChatUrl);
  await owner.getByTestId("share-to-project").click();
  await toast(owner, "Shared with everyone in Launch plan");
  await dev.reload();
  await dev.getByTestId("project-chats").getByText("Shared by Asha Rao").waitFor();
  await dev.getByTestId("project-chats").locator("a", { hasText: "When is the launch?" }).click();
  await dev.getByTestId("read-only").waitFor();
  expect((await dev.locator("textarea").count()) === 0, "composer shown on read-only chat");
});
await step("Projects", "Member chats inside the shared project", dev, async () => {
  await dev.click("text=Start your own chat");
  await dev.getByTestId("project-title").waitFor();
  await send(dev, "Where is the venue?");
  await dev.locator(".prose-chat", { hasText: "Following the project instructions" }).waitFor();
});
await step("Projects", "Move a chat into a project from the sidebar", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  const row = owner.locator("aside div.group", { hasText: "Which model are you?" });
  await row.hover();
  await row.locator('button[aria-label="Chat options"]').click();
  await owner.getByRole("menuitem", { name: "Move to project" }).click();
  await owner.locator('[role="dialog"] button', { hasText: "Launch plan" }).click();
  await toast(owner, "Moved to Launch plan");
  await owner.locator("aside a", { hasText: "Which model are you?" }).waitFor({ state: "detached" });
  await owner.goto(projectUrl);
  await owner.getByTestId("project-chats").getByText("Which model are you?").waitFor();
});
await step("Projects", "Archive a chat and restore it from Settings", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  const row = owner.locator("aside div.group", { hasText: "Draft a polite email" });
  await row.hover();
  await row.locator('button[aria-label="Chat options"]').click();
  await owner.getByRole("menuitem", { name: "Archive" }).click();
  await toast(owner, "Chat archived");
  await owner.locator("aside a", { hasText: "Draft a polite email" }).waitFor({ state: "detached" });
  await owner.goto(`${BASE}/app/settings#archived`);
  await owner.getByText("Draft a polite email").waitFor();
  await owner.click("button:has-text('Restore')");
  await toast(owner, "Chat restored");
  await owner.locator("aside a", { hasText: "Draft a polite email" }).waitFor();
});
await step("Projects", "⌘K finds projects and project chats", owner, async () => {
  await owner.keyboard.press("Control+k");
  await owner.getByTestId("search-input").fill("launch");
  await owner.locator('[role="dialog"] button', { hasText: "Launch plan" }).first().waitFor();
  await owner.getByTestId("search-input").fill("Hall B");
  await owner.locator('[role="dialog"] button', { hasText: "Hall B" }).first().click();
  await owner.waitForURL(/\/app\/projects\/[^/]+\/[^/]+$/);
});
await step("Projects", "Projects page lists projects; delete one after confirming", owner, async () => {
  await owner.goto(`${BASE}/app/projects`);
  await owner.locator("main a, a", { hasText: "Launch plan" }).first().waitFor();
  await owner.click("button:has-text('New project')");
  await owner.fill('[role="dialog"] input', "Scratch");
  await owner.click('[role="dialog"] >> text=Create project');
  await owner.getByTestId("project-title").filter({ hasText: "Scratch" }).waitFor();
  await owner.screenshot({ path: `${OUT}project-home.png` });
  await owner.click('button[aria-label="Project options"]');
  await owner.getByRole("menuitem", { name: "Delete project" }).click();
  await owner.click('[role="dialog"] >> button:has-text("Delete project")');
  await owner.waitForURL("**/app/projects");
  await owner.locator("aside a", { hasText: "Scratch" }).waitFor({ state: "detached" });
});
/* ═════════════ H3. Phase B: versions, temporary chats, labels, export, Excel/OCR ═════════════ */
let branchChatUrl = "";
await step("Phase B", "Editing a message creates a new version; switch between them", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.getByText("where should we start today?").waitFor();
  await send(owner, "Alpha question");
  await send(owner, "Beta question");
  branchChatUrl = owner.url();
  const beta = owner.locator(".group\\/user", { hasText: "Beta question" });
  await beta.hover();
  await beta.locator('button[aria-label="Edit message"]').click();
  await owner.getByTestId("edit-message").locator("textarea").fill("Gamma question");
  const before = await assistantCount(owner);
  await owner.getByTestId("edit-message").locator("button", { hasText: "Send" }).click();
  await owner.locator(".prose-chat", { hasText: "Gamma question" }).waitFor();
  await waitReply(owner, before - 1);
  expect((await owner.getByText("Beta question").count()) === 0, "old version still shown");
  await owner.getByTestId("branch-nav").filter({ hasText: "2/2" }).first().waitFor();
  await owner.click('button[aria-label="Previous version"]');
  await owner.locator(".prose-chat", { hasText: "Beta question" }).waitFor();
  await wait(600);
  await owner.reload();
  await owner.locator(".prose-chat", { hasText: "Beta question" }).waitFor();
  await owner.getByTestId("branch-nav").filter({ hasText: "1/2" }).first().waitFor();
});
await step("Phase B", "Regenerate keeps both answers as versions", owner, async () => {
  const before = await assistantCount(owner);
  await owner.click('button[aria-label="Regenerate"]');
  await owner.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 20000 });
  await wait(500);
  expect((await assistantCount(owner)) === before, "regenerate should replace the shown answer, not append");
  expect((await owner.getByText("Beta question").count()) >= 1, "question repeated or lost");
  await owner.getByTestId("branch-nav").filter({ hasText: "2/2" }).first().waitFor();
});
await step("Phase B", "Download the chat as Word and Markdown, and open the PDF view", owner, async () => {
  await owner.click('header button[aria-label="Chat options"]');
  const [docx] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("menuitem", { name: "Download as Word" }).click()]);
  expect(docx.suggestedFilename().endsWith(".docx"), `bad name ${docx.suggestedFilename()}`);
  const docxPath = await docx.path();
  const { readFileSync } = await import("node:fs");
  expect(readFileSync(docxPath).subarray(0, 2).toString() === "PK", "not a docx");
  await owner.click('header button[aria-label="Chat options"]');
  const [md] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("menuitem", { name: "Download as Markdown" }).click()]);
  const text = readFileSync(await md.path(), "utf8");
  expect(text.includes("Beta question") && !text.includes("Gamma question"), "markdown is not the branch shown");
  await owner.click('header button[aria-label="Chat options"]');
  const [popup] = await Promise.all([owner.context().waitForEvent("page"), owner.getByRole("menuitem", { name: "Download as PDF" }).click()]);
  await popup.locator("article h1").waitFor();
  await popup.locator("article", { hasText: "Beta question" }).waitFor();
  await popup.screenshot({ path: `${OUT}print-view.png` });
  await popup.close();
});
await step("Phase B", "Download one answer as Word", owner, async () => {
  await owner.locator('button[aria-label="Download answer"]').last().click();
  const [one] = await Promise.all([owner.waitForEvent("download"), owner.getByRole("menuitem", { name: "Word document" }).click()]);
  expect(one.suggestedFilename().endsWith(".docx"), "no docx");
});
await step("Phase B", "Temporary chats stay out of history until kept", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.getByTestId("temporary-toggle").click();
  await owner.getByTestId("temporary-notice").waitFor();
  await send(owner, "Temporary zebra note");
  await owner.getByTestId("temporary-notice").waitFor();
  await wait(500);
  expect((await owner.locator("aside a", { hasText: "Temporary zebra note" }).count()) === 0, "temporary chat listed");
  await owner.keyboard.press("Control+k");
  await owner.getByTestId("search-input").fill("zebra");
  await wait(900);
  expect((await owner.locator('[role="dialog"] button', { hasText: "zebra" }).count()) === 0, "temporary chat searchable");
  await owner.keyboard.press("Escape");
  await owner.getByTestId("keep-chat").click();
  await toast(owner, "Chat saved to your history");
  await owner.locator("aside a", { hasText: "Temporary zebra note" }).waitFor();
});
await step("Phase B", "Label a project source; answers show the label", owner, async () => {
  await owner.goto(projectUrl);
  const row = owner.getByTestId("source-row").filter({ hasText: "Launch facts.md" });
  await row.hover();
  await row.locator('button[aria-label="Options for Launch facts.md"]').click();
  await owner.getByRole("menuitem", { name: "Assumption" }).click();
  await row.getByText("Assumption").waitFor();
  await send(owner, "Remind me of the launch date");
  await owner.locator("button", { hasText: "Launch facts.md" }).filter({ hasText: "Assumption" }).first().waitFor();
});
await step("Phase B", "Upload a new version of a source; the old one is set aside", owner, async () => {
  await owner.goto(projectUrl);
  const row = owner.getByTestId("source-row").filter({ hasText: "policy.docx" });
  await row.hover();
  await row.locator('button[aria-label="Options for policy.docx"]').click();
  await owner.getByRole("menuitem", { name: "Upload new version" }).click();
  await owner.getByTestId("version-upload").setInputFiles(fixture("report.pdf"));
  await toast(owner, "New version added");
  await owner.getByTestId("source-row").filter({ hasText: "report.pdf" }).waitFor();
  await owner.getByTestId("source-row").filter({ hasText: "policy.docx" }).getByText("Old version").waitFor();
});
await step("Phase B", "Excel and image files become searchable (OCR)", owner, async () => {
  await owner.goto(`${BASE}/app/documents`);
  await owner.getByTestId("doc-upload").setInputFiles([fixture("budget.xlsx"), fixture("receipt.png")]);
  for (const n of ["budget.xlsx", "receipt.png"]) await docRow(owner, n).waitFor();
  await owner.waitForFunction(() => !document.body.innerText.includes("Processing"), null, { timeout: 30000 });
  expect((await docRow(owner, "receipt.png").getByText("Failed").count()) === 0, "OCR failed");
  await docRow(owner, "receipt.png").locator("button", { hasText: "Ask" }).click();
  await owner.waitForURL(/\?doc=/);
  await send(owner, "What is the invoice number?");
  await owner.locator(".prose-chat", { hasText: "58213" }).waitFor();
});
await step("Member", "Owner disabling Code hides it from the member", owner, async () => {
  await owner.goto(`${BASE}/admin/workspaces/${generalId}`);
  const row = owner.locator("tbody tr", { hasText: "dev@acme.test" });
  await row.locator("button:has-text('Code')").click();
  await wait(700);
  await dev.goto(`${BASE}/app/chat`);
  await dev.locator("aside >> text=Chat").first().waitFor();
  expect((await dev.locator("aside a[href='/app/code']").count()) === 0, "Code still visible");
});

/* ═════════════ I. Quotas & requests ═════════════ */
await step("Quota", "Set a small workspace budget; allowance split evenly", owner, async () => {
  await owner.goto(`${BASE}/admin/workspaces/${generalId}`);
  await owner.click("button:has-text('Budget')");
  await owner.locator('button[role="switch"]').click();
  await owner.fill('input[inputmode="decimal"]', "0.0004");
  await owner.click("text=Save budget");
  await owner.getByText("Budget saved").waitFor();
  await owner.click("button:has-text('Members')");
  await owner.locator("tbody tr", { hasText: "dev@acme.test" }).getByText("of 200").waitFor();
});
await step("Quota", "Member runs out: banner shown, composer disabled", dev, async () => {
  await dev.goto(`${BASE}/app/chat`);
  await dev.locator("textarea").waitFor();
  await wait(1000); // quota loads after the page
  for (let i = 0; i < 4 && !(await dev.locator("textarea").isDisabled()); i++) {
    await dev.locator("textarea").fill(`message ${i}`);
    await dev.keyboard.press("Enter");
    await wait(1500);
  }
  await dev.getByText(/used this month's token allowance/).waitFor();
  expect(await dev.locator("textarea").isDisabled(), "composer still enabled");
  await dev.screenshot({ path: `${OUT}member-quota.png` });
});
await step("Quota", "Member requests more (custom amount, raise limit)", dev, async () => {
  await dev.click("button:has-text('Request more')");
  await dev.fill('input[placeholder^="Custom amount"]', "5");
  await dev.click("button:has-text('Raise my limit')");
  await dev.fill('[role="dialog"] textarea', "Writing the API docs");
  await dev.click("text=Send request");
  await toast(dev, "Request sent");
});
await step("Quota", "Duplicate pending request is refused", dev, async () => {
  await dev.click("button:has-text('Request more')");
  await dev.click("text=Send request");
  await toast(dev, "already have a pending");
  await dev.keyboard.press("Escape");
});
await step("Quota", "Owner gets a notification that links to the inbox", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.locator('button[aria-label^="Notifications ("]').click();
  await owner.getByText("Dev Kumar requested 5K more tokens").click();
  await owner.waitForURL("**/admin/requests");
  await owner.getByText("Writing the API docs").waitFor();
});
await step("Quota", "Owner approves a different amount with a note", owner, async () => {
  await owner.click("button:has-text('Adjust…')");
  await owner.locator('[role="dialog"] input').fill("50");
  await owner.fill('[role="dialog"] textarea', "Go for it");
  await owner.click('[role="dialog"] >> button:has-text("Approve")');
  await owner.getByText("Approved +50K").waitFor();
});
await step("Quota", "Member is notified and can chat again (custom limit)", dev, async () => {
  await dev.reload();
  await dev.locator('button[aria-label^="Notifications ("]').click();
  await dev.getByText(/approved: \+50K/).waitFor();
  await dev.keyboard.press("Escape");
  await send(dev, "Thanks, back to work");
  expect(!(await dev.getByText(/used this month's token allowance/).count()), "still blocked");
  await owner.goto(`${BASE}/admin/workspaces/${generalId}`);
  await owner.locator("tbody tr", { hasText: "dev@acme.test" }).getByText(/custom/).waitFor();
});
await step("Quota", "Admin sets a custom allowance from the member menu", owner, async () => {
  const row = owner.locator("tbody tr", { hasText: "asha@acme.test" });
  await row.locator('button[aria-label="Member actions"]').click();
  await owner.getByRole("menuitem", { name: "Set token allowance" }).click();
  await owner.click('[role="dialog"] >> text=Custom allowance');
  await owner.locator('[role="dialog"] input[inputmode="numeric"]').fill("20");
  await owner.click('[role="dialog"] >> button:has-text("Save")');
  await row.getByText("of 20K · custom").waitFor();
});
await step("Quota", "Usage tab shows allowance and request history", dev, async () => {
  await dev.goto(`${BASE}/app/settings#usage`);
  await dev.getByText("Your requests").waitFor();
  await dev.getByText(/approved 50K|approved/).first().waitFor();
});

/* ═════════════ J. Workspace admin ═════════════ */
const { page: wanda } = await newUser("wanda");
await step("WS admin", "Workspace admin joins and sees a limited console", wanda, async () => {
  await wanda.goto(wandaLink);
  await wanda.fill('input[placeholder="Full name"]', "Wanda Lee");
  await wanda.fill('input[type="password"]', "wanda-good-password");
  await wanda.click("text=Join workspace");
  await wanda.waitForURL("**/app/chat");
  await wanda.goto(`${BASE}/admin`);
  await wanda.waitForURL("**/admin/workspaces");
  for (const hidden of ["Users", "Models", "Audit log", "Settings"])
    expect((await wanda.locator(`aside a:has-text("${hidden}")`).count()) === 0, `${hidden} visible`);
  await wanda.getByText("Workspace admin").first().waitFor();
});
await step("WS admin", "Workspace admin manages members but not budget", wanda, async () => {
  await wanda.locator('a[href^="/admin/workspaces/"]', { hasText: "General" }).click();
  await wanda.locator("tbody tr", { hasText: "dev@acme.test" }).waitFor();
  expect((await wanda.locator("button:has-text('Budget')").count()) === 0, "Budget tab visible");
});
await step("WS admin", "Workspace admin declines a request", wanda, async () => {
  // Wanda exhausts her own allowance? Instead: Dev asks again, Wanda declines.
  await dev.goto(`${BASE}/app/settings#usage`);
  await dev.click("button:has-text('Request more')");
  await dev.click("text=Send request");
  await toast(dev, "Request sent");
  await wanda.goto(`${BASE}/admin/requests`);
  await wanda.click("button:has-text('Decline')");
  await wanda.fill('[role="dialog"] textarea', "Budget is tight this month");
  await wanda.click('[role="dialog"] >> button:has-text("Decline")');
  await wanda.getByText("Declined").first().waitFor();
  await dev.reload();
  await dev.getByText("denied").first().waitFor();
});
await step("WS admin", "Workspace admin usage page works", wanda, async () => {
  await wanda.goto(`${BASE}/admin/usage`);
  await wanda.getByRole("heading", { name: "Tokens per day" }).waitFor();
  expect((await wanda.getByText("Export CSV").count()) === 0, "export visible to ws admin");
});

/* ═════════════ K. User management ═════════════ */
await step("Users", "Make a member org admin, then revert", owner, async () => {
  await owner.goto(`${BASE}/admin/users`);
  const row = () => owner.locator("tbody tr", { hasText: "dev@acme.test" });
  await row().locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Make org admin" }).click();
  await row().getByText("Admin").waitFor();
  await row().locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Remove admin role" }).click();
  await row().getByText("Member").waitFor();
});
await step("Users", "Owner row has no actions menu", owner, async () => {
  expect((await owner.locator("tbody tr", { hasText: "asha@acme.test" }).locator('button[aria-label^="Actions for"]').count()) === 0, "owner has actions");
});
await step("Users", "Deactivate signs the user out and blocks sign-in", owner, async () => {
  const row = owner.locator("tbody tr", { hasText: "dev@acme.test" });
  await row.locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Deactivate" }).click();
  await row.getByText("Deactivated").waitFor();
  await dev.goto(`${BASE}/app/chat`);
  await dev.waitForURL("**/login**");
  await dev.fill('input[type="email"]', "dev@acme.test");
  await dev.fill('input[type="password"]', "another-good-password");
  await dev.click("button:has-text('Continue')");
  await dev.locator(".text-danger").first().waitFor();
});
await step("Users", "Reactivate restores access", owner, async () => {
  const row = owner.locator("tbody tr", { hasText: "dev@acme.test" });
  await row.locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Reactivate" }).click();
  await wait(600);
  await dev.click("button:has-text('Continue')");
  await dev.waitForURL("**/app/chat");
});

/* ═════════════ L. Org settings ═════════════ */
await step("Settings", "Branding: product name, accent and sign-in message", owner, async () => {
  await owner.goto(`${BASE}/admin/settings`);
  await owner.locator("input").nth(1).fill("Acme AI");
  await owner.click('button[aria-label="Accent #A78BFA"]');
  await owner.fill("textarea", "For Acme employees only.");
  await owner.click("text=Save branding");
  await owner.getByText("Settings saved").waitFor();
  await pub.goto(`${BASE}/login`);
  await pub.getByText("Sign in to Acme AI").waitFor();
  await pub.getByText("For Acme employees only.").waitFor();
  const accent = await pub.evaluate(() => document.documentElement.style.getPropertyValue("--accent"));
  expect(accent.toLowerCase() === "#a78bfa", `accent ${accent}`);
  await pub.screenshot({ path: `${OUT}branded-login.png` });
});
await step("Settings", "Budget period change persists", owner, async () => {
  await owner.locator("select").selectOption("week");
  await owner.locator("section", { hasText: "Budget period" }).locator("button:has-text('Save')").click();
  await wait(600);
  await owner.reload();
  expect((await owner.locator("select").inputValue()) === "week", "not saved");
});
await step("Settings", "Conversation recording needs confirmation and shows a notice", owner, async () => {
  await owner.locator("section", { hasText: "Record conversations" }).locator('button[role="switch"]').click();
  await owner.click('[role="dialog"] >> text=Turn on recording');
  await wait(700);
  await dev.goto(`${BASE}/app/chat`);
  await dev.getByText("records chat conversations for compliance").waitFor();
  await owner.locator("section", { hasText: "Record conversations" }).locator('button[role="switch"]').click();
  await wait(700);
  await dev.reload();
  await dev.locator("textarea").waitFor();
  expect((await dev.getByText("records chat conversations").count()) === 0, "notice still shown");
});
await step("Settings", "Retention days save", owner, async () => {
  await owner.locator("section", { hasText: "Delete chats automatically" }).locator("input").fill("90");
  await owner.locator("section", { hasText: "Delete chats automatically" }).locator("button:has-text('Save')").click();
  await owner.getByText("Settings saved").last().waitFor();
});

/* ═════════════ M/N. Audit & usage ═════════════ */
await step("Audit", "Audit log lists events and filters by type", owner, async () => {
  await owner.goto(`${BASE}/admin/audit`);
  await owner.getByText("org.setup").waitFor();
  await owner.locator("select").selectOption("user.");
  await wait(800);
  const actions = await owner.locator("tbody tr td:nth-child(3)").allInnerTexts();
  expect(actions.length > 0 && actions.every((a) => a.startsWith("user.")), `bad filter: ${actions.slice(0, 3)}`);
});
await step("Usage", "Usage totals, ranges and workspace filter", owner, async () => {
  await owner.goto(`${BASE}/admin/usage`);
  await owner.getByText("Total tokens").waitFor();
  await owner.click("button:has-text('7 days')");
  await owner.locator("select").selectOption({ label: "General" });
  await wait(800);
  await owner.getByText("Dev Kumar").first().waitFor();
  await owner.getByText("Deepseek V4 32B").first().waitFor();
});
await step("Usage", "Chart tooltip appears on hover", owner, async () => {
  await owner.locator('[aria-label*="tokens"]').last().hover();
  await owner.getByText("Output").first().waitFor();
});
await step("Usage", "CSV export downloads usage rows", owner, async () => {
  const [dl] = await Promise.all([owner.waitForEvent("download"), owner.click("text=Export CSV")]);
  const path = await dl.path();
  const { readFileSync } = await import("node:fs");
  const csv = readFileSync(path, "utf8");
  expect(csv.startsWith("time,user,workspace,model") && csv.split("\n").length > 3, "bad csv");
});
await step("Overview", "Overview shows stats, chart and provider health", owner, async () => {
  await owner.goto(`${BASE}/admin`);
  await owner.getByText("Active users").waitFor();
  await owner.getByText("Healthy").count();
  await owner.getByText("Ollama").first().waitFor();
});

/* ═════════════ O. Sign-in flows ═════════════ */
await step("Auth", "Sign out returns to sign-in", owner, async () => {
  await owner.goto(`${BASE}/app/chat`);
  await owner.locator("aside button", { hasText: "Asha Rao" }).click();
  await owner.getByRole("menuitem", { name: "Sign out" }).click();
  await owner.waitForURL("**/login");
});
await step("Auth", "Wrong password shows an error", owner, async () => {
  await owner.fill('input[type="email"]', "asha@acme.test");
  await owner.fill('input[type="password"]', "wrong-password-123");
  await owner.click("button:has-text('Continue')");
  await owner.getByText("don't match").waitFor();
});
await step("Auth", "Sign-in honours ?next redirect", owner, async () => {
  await owner.goto(`${BASE}/admin/usage`);
  await owner.waitForURL(/login\?next=/);
  await owner.fill('input[type="email"]', "asha@acme.test");
  await owner.fill('input[type="password"]', "correct-horse-battery");
  await owner.click("button:has-text('Continue')");
  await owner.waitForURL("**/admin/usage");
});

/* ═════════════ P. Mobile ═════════════ */
const { page: mob } = await newUser("mobile", { width: 390, height: 844 });
await step("Mobile", "Chat on mobile: sidebar opens as a drawer and closes", mob, async () => {
  await mob.goto(`${BASE}/login`);
  await mob.fill('input[type="email"]', "asha@acme.test");
  await mob.fill('input[type="password"]', "correct-horse-battery");
  await mob.click("button:has-text('Continue')");
  await mob.waitForURL("**/app/chat");
  await mob.locator('button[aria-label="Open sidebar"]').click();
  await mob.locator("aside >> text=New chat").waitFor();
  await mob.screenshot({ path: `${OUT}mobile-drawer.png` });
  await mob.mouse.click(370, 400);
  await mob.locator('button[aria-label="Open sidebar"]').waitFor();
});
await step("Mobile", "No horizontal scrolling on main pages", mob, async () => {
  const bad = [];
  for (const p of ["/", "/login", "/app/chat", "/app/settings", "/app/work", "/app/code", "/admin", "/admin/users", "/admin/workspaces", "/admin/models", "/admin/requests", "/admin/usage", "/admin/audit", "/admin/settings"]) {
    await mob.goto(`${BASE}${p}`);
    await wait(900);
    const over = await mob.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) bad.push(`${p} (+${over}px)`);
  }
  expect(bad.length === 0, `overflow on ${bad.join(", ")}`);
});

/* ═════════════ Report ═════════════ */
await browser.close();
const pass = results.filter((r) => r.ok).length;
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} [${r.area}] ${r.name}${r.ok ? "" : `  ← ${r.err}`}`);
console.log(`\n${pass}/${results.length} passed`);
console.log("console errors:", consoleErrors.length ? consoleErrors : "none");
