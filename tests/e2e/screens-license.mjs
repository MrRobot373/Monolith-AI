/**
 * Screenshots of the Super Admin console (and the licensed app's License page) for a UI review.
 * Usage: E2E_SCRIPT=tests/e2e/screens-license.mjs tests/e2e/run-licensing.sh
 * Runs licensing.mjs first for its sample data. Writes PNGs and pages.json to $OUT.
 */
import { chromium } from "playwright-core";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";

const CONSOLE = "http://localhost:3100";
const APP = "http://localhost:3200";
const OUT = process.env.OUT ?? new URL("./results-screens-license/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

spawnSync("node", [new URL("./licensing.mjs", import.meta.url).pathname], { stdio: "inherit" });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(base, email, password, state) {
  const c = await browser.newContext();
  const p = await c.newPage();
  await p.goto(`${base}/login`);
  const ok = await (async () => {
    // With single sign-on required, the owner's password form is behind a link.
    const owner = p.getByText("Organization owner? Sign in with a password");
    if (await owner.waitFor({ timeout: 4000 }).then(() => true, () => false)) await owner.click();
    await p.fill('input[type="email"]', email);
    await p.fill('input[type="password"]', password);
    await p.press('input[type="password"]', "Enter");
    await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 10000 });
  })().then(() => true, () => false);
  if (ok) await c.storageState({ path: state });
  const customer = ok && base === CONSOLE ? await firstCustomer(p) : null;
  await c.close();
  return { ok, customer };
}
async function firstCustomer(p) {
  await p.goto(`${CONSOLE}/customers`);
  const row = p.getByTestId("customer-row").first();
  if (!(await row.waitFor({ timeout: 10000 }).then(() => true, () => false))) return null;
  await row.click();
  await p.waitForURL("**/customers/*");
  return new URL(p.url()).pathname;
}

const sa = await signIn(CONSOLE, "root@aatmiq.test", "super-secret-password", `${OUT}console.json`);
const owner = await signIn(APP, "gina@globex.test", "correct-horse-battery", `${OUT}app.json`);

const pages = [
  { group: "License console", name: "Console sign in", url: `${CONSOLE}/login` },
  ...(sa.ok
    ? [
        { group: "License console", name: "Console overview", url: `${CONSOLE}/`, state: "console.json" },
        { group: "License console", name: "Customers", url: `${CONSOLE}/customers`, state: "console.json" },
        ...(sa.customer ? [{ group: "License console", name: "One customer", url: `${CONSOLE}${sa.customer}`, state: "console.json" }] : []),
        { group: "License console", name: "Console settings", url: `${CONSOLE}/settings`, state: "console.json" },
      ]
    : []),
  ...(owner.ok
    ? [
        { group: "Admin (licensed)", name: "License (licensed install)", url: `${APP}/admin/license`, state: "app.json" },
        { group: "Admin (licensed)", name: "Authentication with SSO providers", url: `${APP}/admin/authentication`, state: "app.json" },
      ]
    : []),
];

const VARIANTS = [
  { id: "dark", theme: "dark", viewport: { width: 1440, height: 900 } },
  { id: "light", theme: "light", viewport: { width: 1440, height: 900 } },
  { id: "phone", theme: "dark", viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
];
const index = [];
const errors = [];
if (!sa.ok) errors.push("console sign-in failed");
if (!owner.ok) errors.push("app owner sign-in failed");
for (const v of VARIANTS) {
  for (const [i, pg] of pages.entries()) {
    const c = await browser.newContext({
      viewport: v.viewport,
      isMobile: v.isMobile,
      hasTouch: v.hasTouch,
      deviceScaleFactor: v.deviceScaleFactor ?? 1,
      colorScheme: v.theme,
      storageState: pg.state ? `${OUT}${pg.state}` : undefined,
    });
    await c.addInitScript((t) => localStorage.setItem("aatmiq.theme", t), v.theme);
    const p = await c.newPage();
    p.on("pageerror", (e) => errors.push(`${v.id} ${pg.url}: ${e.message}`));
    const file = `L${String(i + 1).padStart(2, "0")}-${pg.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-$/, "")}-${v.id}.png`;
    try {
      await p.goto(pg.url, { waitUntil: "load" });
      await p.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => {});
      await wait(700);
      await p.screenshot({ path: `${OUT}${file}`, fullPage: true });
      index.push({ n: i + 1, group: pg.group, name: pg.name, path: new URL(pg.url).pathname, variant: v.id, file });
    } catch (e) {
      errors.push(`${v.id} ${pg.url}: ${e.message.split("\n")[0]}`);
    }
    await c.close();
  }
}
writeFileSync(`${OUT}pages.json`, JSON.stringify({ license: index, errors }, null, 1));
console.log(`${index.length} screenshots, ${errors.length} errors`);
for (const e of errors) console.log("  " + e);
await browser.close();
