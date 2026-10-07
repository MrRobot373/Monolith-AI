/**
 * Email, password reset and two-step sign-in in the browser.
 * Usage: E2E_SCRIPT=tests/e2e/account.mjs tests/e2e/run-work.sh   (fresh database, no SMTP_URL)
 * Starts its own test mail server; the admin points Aatmiq at it from Admin → Settings → Email.
 */
import { chromium } from "playwright-core";
import { mkdirSync, rmSync } from "node:fs";
import { startSmtpSink } from "../../apps/api/test/smtp-sink.mjs";
import { totpCode } from "../../apps/api/test/totp.mjs";

const APP = process.env.BASE_URL ?? "http://localhost:3300";
const OUT = new URL("./results-account/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const sink = await startSmtpSink();
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
const results = [];
const consoleErrors = [];
let n = 0;

async function newUser(tag, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"], ...opts });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error" && !/status of (40\d|503)/.test(m.text())) consoleErrors.push(`[${tag}] ${m.text()}`);
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
    await page?.screenshot({ path: `${OUT}FAIL-${id}.png`, fullPage: true }).catch(() => {});
  }
}
const expect = (c, m) => {
  if (!c) throw new Error(m);
};
const shot = (page, name) => page.screenshot({ path: `${OUT}${name}.png`, fullPage: true });
const toast = (page, text) => page.locator("[data-sonner-toast]", { hasText: text }).first().waitFor();
const local = (link) => link.replace(/^https?:\/\/[^/]+/, APP);

async function signIn(page, email, password) {
  await page.goto(`${APP}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', password);
  await page.click("button:has-text('Continue')");
}

/* ═════════════ Owner sets up email ═════════════ */
const { page: owner } = await newUser("owner");
await step("Setup", "Owner sets up Aatmiq", owner, async () => {
  await owner.goto(`${APP}/login`);
  const r = await owner.request.post(`${APP}/api/setup`, { data: { orgName: "Acme Labs", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" }, headers: { origin: APP } });
  expect(r.ok(), `setup ${r.status()}`);
});

await step("Email", "Without email, Forgot password says to ask an admin", owner, async () => {
  const { page, ctx } = await newUser("anon");
  await page.goto(`${APP}/login`);
  await page.getByTestId("forgot-link").click();
  await page.waitForURL("**/forgot-password");
  await page.fill('input[type="email"]', "someone@acme.test");
  await page.click("button:has-text('Send reset link')");
  await page.getByText("Ask your admin for one").waitFor();
  await ctx.close();
});

await step("Email", "Admin → Settings → Email: fill in the server, send a test, save", owner, async () => {
  await owner.goto(`${APP}/admin/settings`);
  await owner.getByTestId("email-form").waitFor();
  await owner.getByTestId("smtp-host").fill("127.0.0.1");
  await owner.getByTestId("smtp-security").selectOption("none");
  await owner.getByTestId("smtp-port").fill(String(sink.port));
  await owner.getByTestId("smtp-username").fill("mailer");
  await owner.getByTestId("smtp-password").fill("smtp-secret");
  await owner.getByTestId("smtp-from").fill("Acme AI <ai@acme.test>");
  await owner.getByTestId("email-form").getByRole("button", { name: "Send test email" }).click();
  await toast(owner, "Test email sent to owner@acme.test");
  const m = await sink.next("owner@acme.test", "test email");
  expect(m.from === "ai@acme.test", `from ${m.from}`);
  await owner.getByTestId("email-save").click();
  await toast(owner, "Email settings saved");
  await owner.getByTestId("email-configured").waitFor();
  await shot(owner, "admin-email-settings");
});

/* ═════════════ Invitation by email ═════════════ */
let inviteLink = "";
await step("Email", "Inviting someone emails them the link", owner, async () => {
  await owner.goto(`${APP}/admin/users`);
  await owner.getByRole("button", { name: "Invite people" }).click();
  await owner.locator('[role="dialog"] input[type="email"]').fill("maya@acme.test");
  await owner.getByRole("button", { name: "Create invitation" }).click();
  await owner.getByText("We emailed the invitation to maya@acme.test").waitFor();
  const m = await sink.next("maya@acme.test", "invited you");
  inviteLink = m.links.find((l) => l.includes("/invite/"));
  expect(inviteLink, "no invite link in the email");
  await shot(owner, "invite-emailed");
  await owner.keyboard.press("Escape");
});

const { page: maya, ctx: mayaCtx } = await newUser("maya");
await step("Email", "The invited person joins from the email link", maya, async () => {
  await maya.goto(local(inviteLink));
  await maya.fill('input[placeholder="Full name"]', "Maya Patel");
  await maya.fill('input[type="password"]', "first-password-123");
  await maya.click("button:has-text('Join workspace')");
  await maya.waitForURL("**/app**");
});

/* ═════════════ Forgot password ═════════════ */
await step("Reset", "Forgot password: the email link lets you choose a new password", maya, async () => {
  await mayaCtx.clearCookies();
  await maya.goto(`${APP}/login`);
  await maya.fill('input[type="email"]', "maya@acme.test");
  await maya.getByTestId("forgot-link").click();
  await maya.waitForURL("**/forgot-password?email=maya%40acme.test");
  expect((await maya.inputValue('input[type="email"]')) === "maya@acme.test", "email not carried over");
  await maya.click("button:has-text('Send reset link')");
  await maya.getByTestId("reset-sent").waitFor();
  await shot(maya, "forgot-sent");
  const m = await sink.next("maya@acme.test", "Reset your");
  const link = m.links.find((l) => l.includes("/reset-password"));
  await maya.goto(local(link));
  await maya.waitForURL("**/reset-password?token=*");
  await maya.getByTestId("new-password").fill("second-password-456");
  await maya.getByTestId("confirm-password").fill("second-password-457");
  await maya.click("button:has-text('Change password')");
  await maya.getByText("The two passwords don't match.").waitFor();
  await maya.getByTestId("confirm-password").fill("second-password-456");
  await shot(maya, "reset-form");
  await maya.click("button:has-text('Change password')");
  await maya.getByTestId("reset-done").waitFor();
  await sink.next("maya@acme.test", "password was changed");
  // The link only works once.
  await maya.goto(local(link));
  await maya.getByTestId("reset-invalid").waitFor();
  await signIn(maya, "maya@acme.test", "second-password-456");
  await maya.waitForURL("**/app**");
});

/* ═════════════ Two-step sign-in ═════════════ */
let secret = "";
let backupCodes = [];
await step("2FA", "Settings → Security: set up two-step sign-in with an authenticator", maya, async () => {
  await maya.goto(`${APP}/app/settings#security`);
  await maya.getByTestId("two-factor-on").click();
  await maya.getByTestId("confirm-with-password").fill("wrong-password-00");
  await maya.getByTestId("password-prompt-submit").click();
  await maya.getByText("That password isn't right.").waitFor();
  await maya.getByTestId("confirm-with-password").fill("second-password-456");
  await maya.getByTestId("password-prompt-submit").click();
  await maya.locator('img[alt="QR code for your authenticator app"]').waitFor();
  await maya.getByText("Can't scan? Enter this key instead").click();
  secret = (await maya.getByTestId("totp-secret").innerText()).replace(/\s/g, "");
  await shot(maya, "two-factor-scan");
  await maya.getByTestId("setup-code").fill("000000");
  await maya.getByTestId("setup-verify").click();
  await maya.getByText("That code isn't right").waitFor();
  await maya.getByTestId("setup-code").fill(totpCode(secret));
  await maya.getByTestId("setup-verify").click();
  await maya.getByTestId("backup-codes").waitFor();
  backupCodes = (await maya.getByTestId("backup-codes").innerText()).split(/\s+/).filter(Boolean);
  expect(backupCodes.length === 10, `${backupCodes.length} backup codes`);
  await shot(maya, "two-factor-backup-codes");
  await maya.getByTestId("setup-done").click();
  await maya.getByText("On", { exact: true }).waitFor();
});

await step("2FA", "Signing in now asks for a code; a wrong one is refused", maya, async () => {
  await mayaCtx.clearCookies();
  await signIn(maya, "maya@acme.test", "second-password-456");
  await maya.getByTestId("two-factor-code").waitFor();
  await shot(maya, "two-factor-sign-in");
  await maya.getByTestId("two-factor-code").fill("123456");
  await maya.getByTestId("two-factor-submit").click();
  await maya.getByText("That code isn't right").waitFor();
  await maya.getByTestId("two-factor-code").fill(totpCode(secret));
  await maya.getByTestId("two-factor-submit").click();
  await maya.waitForURL("**/app**");
});

await step("2FA", "A backup code signs you in once", maya, async () => {
  await mayaCtx.clearCookies();
  await signIn(maya, "maya@acme.test", "second-password-456");
  await maya.getByTestId("use-backup").click();
  await maya.getByTestId("two-factor-code").fill(backupCodes[0]);
  await maya.getByTestId("two-factor-submit").click();
  await maya.waitForURL("**/app**");
  await mayaCtx.clearCookies();
  await signIn(maya, "maya@acme.test", "second-password-456");
  await maya.getByTestId("use-backup").click();
  await maya.getByTestId("two-factor-code").fill(backupCodes[0]);
  await maya.getByTestId("two-factor-submit").click();
  await maya.getByText("isn't valid or was already used").waitFor();
});

await step("Admin", "Admin sees two-step sign-in and turns it off for someone who lost their phone", owner, async () => {
  await owner.goto(`${APP}/admin/users`);
  const row = owner.locator("tr", { hasText: "maya@acme.test" });
  await row.getByTestId("two-factor-badge").waitFor();
  await row.locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Turn off two-step sign-in" }).click();
  await owner.getByRole("button", { name: "Turn off" }).click();
  await toast(owner, "Two-step sign-in is off for Maya Patel");
  await sink.next("maya@acme.test", "Two-step sign-in was turned off");
  await mayaCtx.clearCookies();
  await signIn(maya, "maya@acme.test", "second-password-456");
  await maya.waitForURL("**/app**");
});

await step("Admin", "Admin sends a reset link; with email on it goes to the person", owner, async () => {
  const row = owner.locator("tr", { hasText: "maya@acme.test" });
  await row.locator('button[aria-label^="Actions for"]').click();
  await owner.getByRole("menuitem", { name: "Send password reset link" }).click();
  await owner.getByTestId("send-reset-link").click();
  await owner.getByText("We emailed maya@acme.test a link").waitFor();
  expect((await owner.getByTestId("copy-link").count()) === 0, "the admin should not see the link");
  await shot(owner, "admin-reset-link");
  await sink.next("maya@acme.test", "Reset your");
  await owner.getByRole("button", { name: "Done" }).click();
});

await step("Security", "Change your password in Settings; phone layout has no sideways scroll", maya, async () => {
  await maya.goto(`${APP}/app/settings#security`);
  await maya.getByTestId("change-password").click();
  await maya.getByTestId("current-password").fill("second-password-456");
  await maya.getByTestId("new-password").fill("third-password-789");
  await maya.click("form button:has-text('Change password')");
  await toast(maya, "Password changed");
  await shot(maya, "settings-security");
  const { page: phone, ctx } = await newUser("phone", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await mayaCtx.storageState() });
  await phone.goto(`${APP}/app/settings#security`);
  await phone.getByTestId("two-factor-on").waitFor();
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  expect(!overflow, "horizontal scroll on phone");
  await shot(phone, "settings-security-phone");
  await ctx.close();
});

/* ═════════════ Report ═════════════ */
await browser.close();
await sink.close();
const failed = results.filter((r) => !r.ok);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"} ${r.id} [${r.area}] ${r.name}${r.ok ? "" : `\n      ${r.err}`}`);
if (consoleErrors.length) console.log(`\nConsole errors (${consoleErrors.length}):\n${consoleErrors.slice(0, 15).join("\n")}`);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length || consoleErrors.length ? 1 : 0);
