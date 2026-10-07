/**
 * Screenshots of every page for a UI review (after work.mjs:
 * E2E_SCRIPT=tests/e2e/screens-after-work.mjs tests/e2e/run-work.sh). Adds a little sample data, then captures each
 * page in dark and light on desktop and dark on a phone. Writes PNGs and pages.json to $OUT.
 */
import { chromium } from "playwright-core";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const FAKE = "http://localhost:11500";
const OUT = process.env.OUT ?? new URL("./results-screens/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Sign in as the owner from work.mjs and add sample data ── */
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const api = async (method, path, data, extra = {}) => {
  const r = await page.request.fetch(`${APP}${path}`, { method, data, headers: { origin: APP }, ...extra });
  const json = await r.json().catch(() => null);
  if (r.status() >= 400) console.log(`seed: ${method} ${path} → ${r.status()} ${JSON.stringify(json).slice(0, 160)}`);
  return json;
};
await page.goto(`${APP}/login`);
await page.fill('input[type="email"]', "owner@acme.test");
await page.fill('input[type="password"]', "correct-horse-battery");
await page.click("button:has-text('Continue')");
await page.waitForURL("**/app/**");

const me = await api("GET", "/api/me");
const ws = me.workspaces[0].id;
const provider = (await api("GET", "/api/admin/providers"))[0];
const emb = await api("POST", "/api/admin/models", { providerId: provider.id, modelKey: "nomic-embed-text", displayName: "Nomic Embed", kind: "embedding", sections: ["chat"] });
const wsModels = await api("GET", `/api/admin/workspaces/${ws}/models`);
await api("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: [...wsModels.modelIds, emb?.id].filter(Boolean), defaultModelId: wsModels.defaultModelId, embeddingModelId: emb?.id });
await api("POST", "/api/admin/workspaces", { name: "Marketing" });
const invite = await api("POST", "/api/admin/invites", { email: "dev@acme.test", orgRole: "member", workspaces: [{ workspaceId: ws, role: "member" }] });
await api("POST", "/api/admin/invites", { email: "mia@acme.test", orgRole: "member", workspaces: [] });

// A document in the library.
await api("POST", "/api/documents", undefined, {
  multipart: { workspaceId: ws, file: { name: "Travel policy.txt", mimeType: "text/plain", buffer: Buffer.from("Employees may book economy flights for trips under six hours.\nHotels up to $180 a night.\n") } },
});

// Two chats through the UI so they get real replies and titles.
async function chat(text) {
  await page.goto(`${APP}/app/chat`);
  const before = await page.locator(".prose-chat").count();
  await page.locator("textarea").first().fill(text);
  await page.keyboard.press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".prose-chat").length > n, before, { timeout: 25000 });
  await wait(1500);
  return page.url().split("/").pop();
}
const chatId = await chat("Draft a short email to the team about Friday's release");
await chat("Explain the difference between a list and a tuple in Python");

// A project with instructions, a note and a chat.
const proj = await api("POST", "/api/projects", { workspaceId: ws, name: "Q4 launch", description: "Everything for the October launch", instructions: "Answer in a friendly, concise tone." });
await api("POST", `/api/projects/${proj.id}/sources/note`, { title: "Launch checklist", content: "1. Freeze features on Oct 10\n2. Release notes\n3. Announce on Oct 20" });

// A code workspace (may be unavailable when the IDE isn't installed).
const code = await api("POST", "/api/code/workspaces", { workspaceId: ws, name: "website" });

const tasks = await api("GET", `/api/work/tasks?workspaceId=${ws}`);
const taskId = tasks?.[0]?.id;
await wait(2000); // let the document finish indexing
await ctx.storageState({ path: `${OUT}state.json` });
await ctx.close();

/* ── The pages ── */
const P = (group, name, path, opts = {}) => ({ group, name, path, ...opts });
const pages = [
  P("Public", "Landing page", "/", { signedOut: true }),
  P("Public", "Sign in", "/login", { signedOut: true }),
  P("Public", "Setup (closed after setup)", "/setup", { signedOut: true }),
  P("Public", "Accept invite", invite?.link ? new URL(invite.link).pathname : "/invite/none", { signedOut: true }),
  P("Public", "Invalid invite", "/invite/not-a-real-token", { signedOut: true }),
  P("App", "Chat (new)", "/app/chat"),
  P("App", "Chat (conversation)", `/app/chat/${chatId}`),
  P("App", "Print view of a chat", `/print/chat/${chatId}`),
  P("App", "Documents", "/app/documents"),
  P("App", "Projects", "/app/projects"),
  P("App", "One project", `/app/projects/${proj?.id}`),
  P("App", "Settings", "/app/settings"),
  P("Work AI", "Work AI home", "/app/work"),
  P("Work AI", "One task", `/app/work/${taskId}`),
  P("Work AI", "Skills and Library", "/app/work/skills"),
  P("Work AI", "Connections", "/app/work/connections"),
  P("Work AI", "Schedules", "/app/work/schedules"),
  P("Code", "Code workspaces", "/app/code"),
  ...(code?.id ? [P("Code", "One code workspace", `/app/code/${code.id}`)] : []),
  P("Admin", "Overview", "/admin"),
  P("Admin", "Users", "/admin/users"),
  P("Admin", "Workspaces", "/admin/workspaces"),
  P("Admin", "One workspace", `/admin/workspaces/${ws}`),
  P("Admin", "Models", "/admin/models"),
  P("Admin", "Work AI", "/admin/work"),
  P("Admin", "Requests", "/admin/requests"),
  P("Admin", "Usage", "/admin/usage"),
  P("Admin", "Audit log", "/admin/audit"),
  P("Admin", "Authentication", "/admin/authentication"),
  P("Admin", "Settings", "/admin/settings"),
  P("Admin", "License", "/admin/license"),
];

const VARIANTS = [
  { id: "dark", theme: "dark", viewport: { width: 1440, height: 900 } },
  { id: "light", theme: "light", viewport: { width: 1440, height: 900 } },
  { id: "phone", theme: "dark", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];

const index = [];
const errors = [];
for (const v of VARIANTS) {
  for (const signedOut of [true, false]) {
    const c = await browser.newContext({
      viewport: v.viewport,
      isMobile: v.isMobile,
      hasTouch: v.hasTouch,
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      colorScheme: v.theme,
      storageState: signedOut ? undefined : `${OUT}state.json`,
    });
    await c.addInitScript((t) => localStorage.setItem("aatmiq.theme", t), v.theme);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(`${v.id} ${p.url()}: ${e.message}`));
    for (const [i, pg] of pages.entries()) {
      if (!!pg.signedOut !== signedOut) continue;
      const file = `${String(i + 1).padStart(2, "0")}-${pg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}-${v.id}.png`;
      try {
        await p.goto(`${APP}${pg.path}`, { waitUntil: "load" });
        await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
        await wait(700);
        await p.screenshot({ path: `${OUT}${file}`, fullPage: true });
        index.push({ n: i + 1, group: pg.group, name: pg.name, path: pg.path, variant: v.id, file, finalPath: new URL(p.url()).pathname });
      } catch (e) {
        errors.push(`${v.id} ${pg.path}: ${e.message.split("\n")[0]}`);
      }
    }
    await c.close();
  }
}
writeFileSync(`${OUT}pages.json`, JSON.stringify({ app: index, errors }, null, 1));
console.log(`${index.length} screenshots, ${errors.length} errors`);
for (const e of errors) console.log("  " + e);
await browser.close();
