/**
 * The desktop app (apps/desktop) against a running Aatmiq (run with run-work.sh:
 * E2E_SCRIPT=…/desktop.mjs, after pnpm --filter @aatmiq/desktop build). Drives the real Electron
 * app: the connect screen, signing in, the IDE in its own window, what remote pages may and may
 * not do, and remembering the server. Starts Xvfb when there's no display.
 */
import { _electron as electron } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const FAKE = "http://localhost:11500";
const ROOT = new URL("../../", import.meta.url).pathname;
const DESKTOP = join(ROOT, "apps/desktop");
const OUT = new URL("./results-desktop/shots/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const electronPath = createRequire(join(DESKTOP, "package.json"))("electron");

let xvfb = null;
if (!process.env.DISPLAY) {
  xvfb = spawn("Xvfb", [":97", "-screen", "0", "1600x1000x24", "-nolisten", "tcp"], { stdio: "ignore" });
  process.env.DISPLAY = ":97";
  await new Promise((r) => setTimeout(r, 800));
}

const userData = mkdtempSync(join(tmpdir(), "aatmiq-desktop-"));
const launch = (dir = userData) =>
  electron.launch({
    executablePath: electronPath,
    // Root (as in CI containers) needs --no-sandbox; pages stay sandboxed by Electron's own settings.
    args: [...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), DESKTOP],
    env: { ...process.env, AATMIQ_DESKTOP_USER_DATA: dir },
  });

const results = [];
const consoleErrors = [];
let n = 0;
let app;
let page;
async function step(area, name, fn) {
  n++;
  const id = String(n).padStart(2, "0");
  try {
    await fn();
    results.push({ id, area, name, ok: true });
  } catch (e) {
    results.push({ id, area, name, ok: false, err: e.message.split("\n")[0].slice(0, 240) });
    if (process.env.DEBUG_E2E) console.error(`--- ${id} ${name}\n${e.message.slice(0, 3000)}`);
    for (const w of app?.windows() ?? []) await w.screenshot({ path: `${OUT}FAIL-${id}-${app.windows().indexOf(w)}.png` }).catch(() => {});
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const watch = (p, tag) => {
  p.on("console", (m) => {
    if (m.type() === "error" && !/status of 40\d|Long running operations during shutdown|BroadcastChannel|Unable to load and parse grammar/.test(m.text())) consoleErrors.push(`[${tag}] ${m.text()}`);
  });
  p.on("pageerror", (e) => consoleErrors.push(`[${tag}] pageerror: ${e.message}`));
  p.setDefaultTimeout(20000);
  return p;
};
const until = async (fn, ms = 20000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
};
const windowAt = (pattern) => until(async () => app.windows().find((w) => pattern.test(w.url())));
// Links that would go to the person's browser are recorded instead.
const stubBrowser = () =>
  app.evaluate(({ shell }) => {
    globalThis.opened = [];
    shell.openExternal = async (u) => void globalThis.opened.push(u);
  });
const opened = () => app.evaluate(() => globalThis.opened ?? []);

/* ═════════════ Setup (an Aatmiq with an owner and a model) ═════════════ */
let cookie = "";
const api = async (method, path, body) => {
  const r = await fetch(`${APP}${path}`, { method, headers: { origin: APP, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = r.headers.get("set-cookie");
  if (set) cookie = set.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};
await step("Setup", "An Aatmiq server with an owner and a model for Code", async () => {
  expect((await api("POST", "/api/setup", { orgName: "Acme Labs", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status === 200, "setup");
  const ws = (await api("GET", "/api/me")).json.workspaces[0].id;
  const p = await api("POST", "/api/admin/providers", { name: "Local vLLM", type: "openai_compatible", baseUrl: `${FAKE}/v1` });
  const m = await api("POST", "/api/admin/models", { providerId: p.json.id, modelKey: "qwen3:8b", displayName: "Qwen3 8B", sections: ["chat", "work", "code"] });
  await api("PUT", `/api/admin/workspaces/${ws}/models`, { modelIds: [m.json.id], defaultModelId: m.json.id });
  const info = await api("GET", "/api/public/desktop");
  expect(info.json?.product === "aatmiq" && info.json.appOrigin === new URL(APP).origin, `desktop info ${JSON.stringify(info.json)}`);
});

/* ═════════════ Connect ═════════════ */
await step("Connect", "First start: the connect screen explains and checks the address", async () => {
  app = await launch();
  page = watch(await app.firstWindow(), "connect");
  await page.getByText("Connect to your organization's Aatmiq server").waitFor();
  expect((await page.title()) === "Connect to your server", `title ${await page.title()}`);
  // The connect screen has its bridge; nothing else.
  expect(await page.evaluate(() => typeof window.aatmiqDesktop?.connect === "function" && typeof require === "undefined" && typeof process === "undefined"), "connect page bridge");
  await page.screenshot({ path: `${OUT}connect.png` });
  await page.locator("#address").fill("http://aatmiq.example.com");
  await page.locator("#go").click();
  await page.getByText("Use https://").waitFor();
  await page.locator("#address").fill(FAKE);
  await page.locator("#go").click();
  await page.getByText("isn't an Aatmiq server").waitFor();
  await page.screenshot({ path: `${OUT}connect-error.png` });
});

await step("Connect", "Connects; Aatmiq Code opens and sign-in works as on the web", async () => {
  await page.locator("#address").fill(APP);
  await page.locator("#go").click();
  page = watch(await windowAt(/\/login/), "app");
  expect(page.url().includes("next=%2Fapp%2Fcode"), `sign-in returns to Code: ${page.url()}`);
  await page.locator('input[type="email"]').fill("owner@acme.test");
  await page.locator('input[type="password"]').fill("correct-horse-battery");
  await page.keyboard.press("Enter");
  await page.waitForURL(/\/app\/code$/);
  await page.getByText("No workspaces yet").waitFor();
  expect(app.windows().length === 1, `windows: ${app.windows().length} (the connect screen should be closed)`);
  await page.screenshot({ path: `${OUT}code-home.png` });
});

/* ═════════════ What pages may do ═════════════ */
await step("Safety", "Aatmiq's pages get no Node and no app bridge; the server sees the desktop app", async () => {
  const r = await page.evaluate(() => ({ require: typeof require, process: typeof process, bridge: typeof window.aatmiqDesktop, ua: navigator.userAgent }));
  expect(r.require === "undefined" && r.process === "undefined" && r.bridge === "undefined", JSON.stringify(r));
  expect(/AatmiqDesktop\/\d/.test(r.ua), `user agent ${r.ua}`);
});

await step("Safety", "Links elsewhere open in the browser; local files and scripts go nowhere", async () => {
  await stubBrowser();
  const before = app.windows().length;
  await page.evaluate(() => window.open("https://example.com/docs", "_blank"));
  await page.evaluate(() => (location.href = "https://example.org/pricing"));
  await page.evaluate(() => (location.href = "file:///etc/passwd"));
  await until(async () => (await opened()).length === 2);
  expect(JSON.stringify(await opened()) === JSON.stringify(["https://example.com/docs", "https://example.org/pricing"]), `opened ${JSON.stringify(await opened())}`);
  await page.waitForTimeout(500);
  expect(app.windows().length === before, "a window opened");
  expect(page.url().startsWith(`${APP}/app/code`), `navigated away: ${page.url()}`);
  // Chromium's own refusal of the file: link is expected; Playwright still waits on the cancelled
  // navigations, so start a fresh one.
  for (let i = consoleErrors.length - 1; i >= 0; i--) if (consoleErrors[i].includes("Not allowed to load local resource: file:///etc/passwd")) consoleErrors.splice(i, 1);
  await page.goto(`${APP}/app/code`);
});

await step("Safety", "The clipboard works (the IDE needs it); location and camera are refused", async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.focus());
  await page.bringToFront();
  const clip = await page.evaluate(async () => {
    await navigator.clipboard.writeText("from Aatmiq");
    return navigator.clipboard.readText();
  });
  expect(clip === "from Aatmiq", `clipboard: ${clip}`);
  const geo = await page.evaluate(() => new Promise((r) => navigator.geolocation.getCurrentPosition(() => r("granted"), (e) => r(e.code))));
  expect(geo === 1, `geolocation: ${geo}`);
  const cam = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: true }).then(() => "granted", (e) => e.name));
  expect(cam !== "granted", `camera: ${cam}`);
});

/* ═════════════ The IDE ═════════════ */
let ideWindow;
await step("IDE", "A workspace's IDE runs in the app and opens in a window of its own", async () => {
  await page.getByTestId("new-code-workspace").click();
  await page.getByTestId("code-workspace-name").fill("Billing service");
  await page.getByTestId("create-code-workspace").click();
  await page.waitForURL(/\/app\/code\/[\w-]+$/);
  await page.frameLocator('[data-testid="ide-frame"]').locator(".monaco-workbench").waitFor({ timeout: 60000 });
  await page.getByTestId("open-ide-tab").getByText("Open in new window").waitFor();
  const count = app.windows().length;
  await page.getByTestId("open-ide-tab").click();
  ideWindow = watch(await until(async () => app.windows().length > count && app.windows().at(-1)), "ide");
  await until(async () => /\/code\/ide/.test(ideWindow.url()));
  await ideWindow.locator(".monaco-workbench").waitFor({ timeout: 60000 });
  await ideWindow.locator(".explorer-folders-view, .explorer-viewlet").first().waitFor();
  await ideWindow.screenshot({ path: `${OUT}ide-window.png` });
});

await step("IDE", "Ctrl+W and Ctrl+N reach the IDE instead of closing or opening app windows", async () => {
  const count = app.windows().length;
  await ideWindow.locator(".monaco-workbench").click({ position: { x: 600, y: 300 } });
  await ideWindow.keyboard.press("Control+N");
  await ideWindow.locator(".tab").filter({ hasText: "Untitled-1" }).waitFor();
  await ideWindow.keyboard.press("Control+W");
  await until(async () => (await ideWindow.locator(".tab").filter({ hasText: "Untitled-1" }).count()) === 0);
  await ideWindow.waitForTimeout(500);
  expect(app.windows().length === count, `windows: ${app.windows().length}, expected ${count}`);
  expect(!ideWindow.isClosed(), "the IDE window closed");
});

await step("IDE", "The Aatmiq panel (a webview) and a terminal (a WebSocket) work in the window", async () => {
  await ideWindow.frameLocator("iframe.webview").frameLocator("iframe").getByText("What should we build?").waitFor({ timeout: 40000 });
  await ideWindow.keyboard.press("Control+`");
  await ideWindow.locator(".xterm").first().waitFor({ timeout: 30000 });
  await ideWindow.waitForTimeout(1500);
  await ideWindow.locator(".xterm").first().click();
  await ideWindow.keyboard.type("echo desktop > from-desktop.txt\n");
  await ideWindow.locator(".explorer-folders-view").getByText("from-desktop.txt").waitFor();
  await ideWindow.screenshot({ path: `${OUT}ide-panel-terminal.png` });
});

/* ═════════════ Remembering ═════════════ */
await step("Remember", "Next start goes straight to the server, still signed in", async () => {
  await app.close();
  app = await launch();
  page = watch(await app.firstWindow(), "app2");
  await page.waitForURL(/\/app\/code/);
  await page.getByText("Billing service").first().waitFor();
  expect(!/\/login/.test(page.url()), "signed out");
});

await step("Remember", "File → Switch Server shows the connect screen with the current address", async () => {
  await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById("switch-server").click());
  const c = watch(await windowAt(/connect\.html/), "connect2");
  await until(async () => (await c.locator("#address").inputValue()) === new URL(APP).origin);
  await c.close();
});

await step("Offline", "A server that doesn't answer shows a retry page, not a blank window", async () => {
  await app.close();
  const dir = mkdtempSync(join(tmpdir(), "aatmiq-desktop-off-"));
  const dead = "http://127.0.0.1:9";
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ server: dead, info: { product: "aatmiq", name: "Acme AI", appOrigin: dead, ideOrigin: null, signInOrigins: [] } }));
  app = await launch(dir);
  const w = watch(await app.firstWindow(), "offline");
  await until(async () => /offline\.html/.test(w.url()));
  await w.getByText("didn't answer").waitFor();
  expect((await w.getByRole("link", { name: "Try again" }).getAttribute("href")).startsWith(dead), "retry link");
  await w.screenshot({ path: `${OUT}offline.png` });
  // Errors from the dead server are what this step expects.
  for (let i = consoleErrors.length - 1; i >= 0; i--) if (consoleErrors[i].startsWith("[offline]")) consoleErrors.splice(i, 1);
});

/* ═════════════ Report ═════════════ */
await app?.close().catch(() => {});
xvfb?.kill();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} [${r.area}] ${r.name}${r.ok ? "" : `\n      ${r.err}`}`);
if (consoleErrors.length) console.log(`\nConsole errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 15).join("\n")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
