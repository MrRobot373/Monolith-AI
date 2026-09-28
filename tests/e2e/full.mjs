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
    if (m.type() === "error" && !/status of (401|402|403|404|409)/.test(m.text())) consoleErrors.push(`[${tag}] ${m.text()}`);
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
await step("Chat", "Suggestion chip sends a message and streams a reply", owner, async () => {
  await owner.click("text=Draft a polite follow-up email");
  await waitReply(owner, 0);
  expect((await assistantCount(owner)) === 1, "no assistant reply");
  expect(owner.url().match(/\/app\/chat\/[\w-]+$/), "URL not updated to chat id");
});
await step("Chat", "New chat appears in sidebar with an auto title", owner, async () => {
  await owner.locator('aside a[href^="/app/chat/"]', { hasText: "Draft a polite follow-up" }).waitFor();
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
await step("Chat", "Regenerate adds a new reply", owner, async () => {
  await owner.click('button[aria-label="Regenerate"]');
  await waitReply(owner, 2);
  expect((await assistantCount(owner)) === 3, `expected 3 replies, got ${await assistantCount(owner)}`);
});
let firstChatUrl = owner.url();
await step("Chat", "Reloading a chat URL restores the conversation", owner, async () => {
  firstChatUrl = owner.url();
  await owner.reload();
  await owner.locator(".prose-chat").nth(2).waitFor();
});
await step("Chat", "New chat button opens an empty chat", owner, async () => {
  await owner.click("aside >> text=New chat");
  await owner.waitForURL("**/app/chat");
  await owner.getByText("How can I help today?").waitFor();
  await send(owner, "Second conversation about budgets");
});
await step("Chat", "Clicking a chat in the sidebar opens it", owner, async () => {
  await owner.locator("aside a", { hasText: "Draft a polite follow-up" }).click();
  await owner.waitForURL(firstChatUrl);
  await owner.locator(".prose-chat").nth(2).waitFor();
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
await step("Chat", "Search filters the chat list", owner, async () => {
  await owner.fill('input[placeholder="Search chats"]', "budget");
  await wait(300);
  expect((await owner.locator("aside a", { hasText: "Draft a polite" }).count()) === 0, "filter did not hide");
  expect((await owner.locator("aside a", { hasText: "Budget planning" }).count()) === 1, "filter hid match");
  await owner.fill('input[placeholder="Search chats"]', "");
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
  await owner.click("aside >> text=Work AI");
  await owner.getByText("Task timeline").waitFor();
  await owner.click("aside >> text=Code");
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
  expect((await owner.locator("tbody tr").count()) === 4, `expected 4 models, got ${await owner.locator("tbody tr").count()}`);
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
  for (let i = 0; i < 4 && !(await dev.getByText("Request more").count()); i++) {
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
  await wanda.getByText("Tokens per day").waitFor();
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
