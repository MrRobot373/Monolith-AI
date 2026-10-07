/** Email (SMTP), password resets and two-step sign-in, against a local test mail server. */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSmtpSink } from "../test/smtp-sink.mjs";
import { totpCode } from "../test/totp.mjs";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

d("Email, password reset and two-step sign-in", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  const owner = jar();
  let workspaceId = "";
  let mayaId = "";

  function absorb(j: Jar, set: string | string[] | undefined) {
    if (!set) return;
    const map = new Map(j.cookie.split("; ").filter(Boolean).map((c) => c.split("=") as [string, string]));
    for (const c of Array.isArray(set) ? set : [set]) {
      const [k, ...v] = c.split(";")[0]!.split("=");
      const value = v.join("=");
      if (/max-age=0/i.test(c) || value === "") map.delete(k!);
      else map.set(k!, value);
    }
    j.cookie = [...map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  async function call(j: Jar | null, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(j?.cookie ? { cookie: j.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (j) absorb(j, res.headers["set-cookie"]);
    let json = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, headers: res.headers };
  }
  const signIn = (j: Jar, email: string, password: string) => call(j, "POST", "/api/auth/sign-in/email", { email, password });
  /** Follows a reset link from an email: Better Auth's callback redirects to /reset-password?token=…. */
  async function tokenFrom(link: string) {
    const u = new URL(link);
    if (u.pathname === "/reset-password") return u.searchParams.get("token")!;
    const r = await app.inject({ method: "GET", url: u.pathname + u.search });
    expect(r.statusCode).toBe(302);
    return new URL(String(r.headers.location), APP_URL).searchParams.get("token")!;
  }
  async function invite(email: string, role: "member" | "admin" = "member") {
    const r = await call(owner, "POST", "/api/admin/invites", { email, orgRole: role, workspaces: [{ workspaceId, role: "member" }] });
    expect(r.status).toBe(200);
    return r.json as { link: string; emailed: boolean };
  }
  async function join(link: string, name: string, password = "first-password-123") {
    const token = new URL(link).pathname.split("/").pop();
    const j = jar();
    expect((await call(j, "POST", `/api/invites/${token}/accept`, { name, password })).status).toBe(200);
    return j;
  }

  beforeAll(async () => {
    sink = await startSmtpSink();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: "test-secret-test-secret-test-secret-1234", allowMockProvider: true, port: 0, storageDir: "" };
    app = await buildApp(db, cfg);
    await call(owner, "POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
    await sink?.close();
  });

  it("without email: invites return a link, reset requests say to ask an admin, and an admin link works", async () => {
    const inv = await invite("maya@acme.test");
    expect(inv.emailed).toBe(false);
    const maya = await join(inv.link, "Maya Patel");
    mayaId = (await call(maya, "GET", "/api/me")).json.user.id;
    expect((await call(maya, "GET", "/api/me/security")).json).toMatchObject({ hasPassword: true, twoFactorEnabled: false, emailEnabled: false });

    const req = await call(null, "POST", "/api/auth/request-password-reset", { email: "maya@acme.test", redirectTo: "/reset-password" });
    expect(req.status).toBe(503);
    expect(req.json.error).toContain("Ask your admin");

    // Admins can't do this for the owner or themselves; members can't at all.
    const ownerId = (await call(owner, "GET", "/api/me")).json.user.id;
    expect((await call(owner, "POST", `/api/admin/users/${ownerId}/reset-link`)).status).toBe(403);
    expect((await call(maya, "POST", `/api/admin/users/${ownerId}/reset-link`)).status).toBe(403);

    const r = await call(owner, "POST", `/api/admin/users/${mayaId}/reset-link`);
    expect(r.json).toMatchObject({ emailed: false, expiresInMinutes: 60 });
    expect(r.json.link).toMatch(/^http:\/\/localhost:3000\/reset-password\?token=/);
    const token = await tokenFrom(r.json.link);
    expect((await call(null, "POST", "/api/auth/reset-password", { token, newPassword: "short" })).status).toBe(400);
    expect((await call(null, "POST", "/api/auth/reset-password", { token, newPassword: "second-password-456" })).status).toBe(200);
    // Used once; old sessions are signed out; the new password works and the old one doesn't.
    expect((await call(null, "POST", "/api/auth/reset-password", { token, newPassword: "third-password-789" })).status).toBe(400);
    expect((await call(maya, "GET", "/api/me")).status).toBe(401);
    expect((await signIn(jar(), "maya@acme.test", "first-password-123")).status).toBe(401);
    expect((await signIn(maya, "maya@acme.test", "second-password-456")).status).toBe(200);
    const audit = (await call(owner, "GET", "/api/admin/audit?limit=20")).json;
    const actions = (Array.isArray(audit) ? audit : audit.rows ?? audit.events ?? []).map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["user.reset_link", "user.password_reset"]));
  });

  it("admins set up the mail server; the password is never shown; a test email arrives", async () => {
    const maya = jar();
    await signIn(maya, "maya@acme.test", "second-password-456");
    expect((await call(maya, "GET", "/api/admin/email")).status).toBe(403);
    expect((await call(owner, "GET", "/api/admin/email")).json).toEqual({ source: null });

    const form = { host: "127.0.0.1", port: sink.port, security: "none", username: "mailer", password: "smtp-pass", from: "Acme AI <ai@acme.test>" };
    // Test before saving (uses the form), then save.
    const t = await call(owner, "POST", "/api/admin/email/test", form);
    expect(t.json).toEqual({ ok: true, to: "owner@acme.test" });
    const m = await sink.next("owner@acme.test", "test email");
    expect(m.from).toBe("ai@acme.test");
    expect(m.text).toContain("Email from Aatmiq works");

    expect((await call(owner, "PUT", "/api/admin/email", form)).status).toBe(200);
    const got = (await call(owner, "GET", "/api/admin/email")).json;
    expect(got).toMatchObject({ source: "settings", host: "127.0.0.1", port: sink.port, username: "mailer", hasPassword: true });
    expect(JSON.stringify(got)).not.toContain("smtp-pass");
    const stored = await db.execute(sql`select email_settings::text as s from organization`);
    expect(String((stored as unknown as { s: string }[])[0]!.s)).not.toContain("smtp-pass");
    // Saving without a password keeps the saved one.
    const { password: _p, ...noPassword } = form;
    await call(owner, "PUT", "/api/admin/email", noPassword);
    expect((await call(owner, "GET", "/api/admin/email")).json.hasPassword).toBe(true);

    // A mail server that refuses connections gives a clear error.
    const bad = await call(owner, "POST", "/api/admin/email/test", { ...form, port: 1 });
    expect(bad.status).toBe(502);
    expect(bad.json.error).toContain("mail server");
  });

  it("invitations are emailed", async () => {
    const inv = await invite("ravi@acme.test");
    expect(inv.emailed).toBe(true);
    const m = await sink.next("ravi@acme.test", "invited you");
    expect(m.subject).toBe("Asha Owner invited you to Acme");
    expect(m.links).toContain(inv.link);
    await join(inv.link, "Ravi Kumar");
  });

  it("forgot password: the email link resets it once and confirms the change", async () => {
    const maya = jar();
    await signIn(maya, "maya@acme.test", "second-password-456");
    const r = await call(null, "POST", "/api/auth/request-password-reset", { email: "Maya@Acme.test", redirectTo: "/reset-password" });
    expect(r.status).toBe(200);
    const m = await sink.next("maya@acme.test", "Reset your");
    expect(m.text).toContain("expires in 60 minutes");
    const link = m.links.find((l) => l.includes("/api/auth/reset-password/"))!;
    expect(link).toBeTruthy();
    const token = await tokenFrom(link);
    expect((await call(null, "POST", "/api/auth/reset-password", { token, newPassword: "fourth-password-000" })).status).toBe(200);
    const changed = await sink.next("maya@acme.test", "password was changed");
    expect(changed.text).toContain("signed out everywhere else");
    expect((await call(maya, "GET", "/api/me")).status).toBe(401);
    expect((await signIn(jar(), "maya@acme.test", "fourth-password-000")).status).toBe(200);

    // Unknown addresses get the same answer and no email.
    const before = sink.messages.length;
    expect((await call(null, "POST", "/api/auth/request-password-reset", { email: "nobody@acme.test", redirectTo: "/reset-password" })).status).toBe(200);
    await new Promise((res) => setTimeout(res, 300));
    expect(sink.messages.length).toBe(before);
  });

  it("no reset email for deactivated people or, with SSO required, anyone but the owner", async () => {
    const ravi = (await call(owner, "GET", "/api/admin/users")).json.find((u: { email: string }) => u.email === "ravi@acme.test");
    await call(owner, "PATCH", `/api/admin/users/${ravi.id}`, { status: "deactivated" });
    const before = sink.messages.length;
    await call(null, "POST", "/api/auth/request-password-reset", { email: "ravi@acme.test", redirectTo: "/reset-password" });
    expect((await call(owner, "POST", `/api/admin/users/${ravi.id}/reset-link`)).status).toBe(400);
    await call(owner, "PATCH", `/api/admin/users/${ravi.id}`, { status: "active" });

    await db.execute(sql`update organization set sso_required = true`);
    await call(null, "POST", "/api/auth/request-password-reset", { email: "maya@acme.test", redirectTo: "/reset-password" });
    await new Promise((res) => setTimeout(res, 300));
    expect(sink.messages.length).toBe(before);
    // The owner still gets one (break-glass).
    await call(null, "POST", "/api/auth/request-password-reset", { email: "owner@acme.test", redirectTo: "/reset-password" });
    await sink.next("owner@acme.test", "Reset your");
    await db.execute(sql`update organization set sso_required = false`);
  });

  it("with email on, an admin's reset link goes to the person, not the admin", async () => {
    const r = await call(owner, "POST", `/api/admin/users/${mayaId}/reset-link`);
    expect(r.json).toEqual({ emailed: true, email: "maya@acme.test", expiresInMinutes: 60 });
    const m = await sink.next("maya@acme.test", "Reset your");
    expect(m.text).toContain("Asha Owner sent you a link");
    expect(m.links.some((l) => l.startsWith("http://localhost:3000/reset-password?token="))).toBe(true);
  });

  it("two-step sign-in: set up with an authenticator, then every password sign-in needs a code", async () => {
    const maya = jar();
    await signIn(maya, "maya@acme.test", "fourth-password-000");
    expect((await call(maya, "POST", "/api/auth/two-factor/enable", { password: "wrong-password-0" })).status).toBe(400);
    const en = await call(maya, "POST", "/api/auth/two-factor/enable", { password: "fourth-password-000" });
    expect(en.status).toBe(200);
    const uri: string = en.json.totpURI;
    expect(uri).toMatch(/^otpauth:\/\/totp\/Aatmiq:maya%40acme\.test\?/);
    expect(en.json.backupCodes).toHaveLength(10);
    // Not on until the first code is confirmed.
    expect((await call(maya, "GET", "/api/me/security")).json.twoFactorEnabled).toBe(false);
    expect((await call(maya, "POST", "/api/auth/two-factor/verify-totp", { code: "000000" })).status).toBe(401);
    expect((await call(maya, "POST", "/api/auth/two-factor/verify-totp", { code: totpCode(uri) })).status).toBe(200);
    expect((await call(maya, "GET", "/api/me/security")).json.twoFactorEnabled).toBe(true);

    // Password alone no longer signs in.
    const j = jar();
    const s = await signIn(j, "maya@acme.test", "fourth-password-000");
    expect(s.json).toMatchObject({ twoFactorRedirect: true, twoFactorMethods: ["totp"] });
    expect((await call(j, "GET", "/api/me")).status).toBe(401);
    expect((await call(j, "POST", "/api/auth/two-factor/verify-totp", { code: "123456" })).status).toBe(401);
    expect((await call(j, "POST", "/api/auth/two-factor/verify-totp", { code: totpCode(uri) })).status).toBe(200);
    expect((await call(j, "GET", "/api/me")).status).toBe(200);

    // A backup code works once.
    const code = en.json.backupCodes[0];
    const b = jar();
    await signIn(b, "maya@acme.test", "fourth-password-000");
    expect((await call(b, "POST", "/api/auth/two-factor/verify-backup-code", { code })).status).toBe(200);
    expect((await call(b, "GET", "/api/me")).status).toBe(200);
    const b2 = jar();
    await signIn(b2, "maya@acme.test", "fourth-password-000");
    expect((await call(b2, "POST", "/api/auth/two-factor/verify-backup-code", { code })).status).toBe(401);

    // The admin's users list shows it; the admin can turn it off for someone who lost their phone.
    const listed = (await call(owner, "GET", "/api/admin/users")).json.find((u: { email: string }) => u.email === "maya@acme.test");
    expect(listed.twoFactorEnabled).toBe(true);
    expect((await call(owner, "POST", `/api/admin/users/${mayaId}/two-factor/disable`)).status).toBe(200);
    await sink.next("maya@acme.test", "Two-step sign-in was turned off");
    const after = jar();
    expect((await signIn(after, "maya@acme.test", "fourth-password-000")).json.twoFactorRedirect).toBeUndefined();
    expect((await call(after, "GET", "/api/me")).status).toBe(200);
  });

  it("people can turn two-step sign-in off themselves with their password", async () => {
    const maya = jar();
    await signIn(maya, "maya@acme.test", "fourth-password-000");
    const en = await call(maya, "POST", "/api/auth/two-factor/enable", { password: "fourth-password-000" });
    await call(maya, "POST", "/api/auth/two-factor/verify-totp", { code: totpCode(en.json.totpURI) });
    expect((await call(maya, "POST", "/api/auth/two-factor/disable", { password: "nope-nope-nope" })).status).toBe(400);
    expect((await call(maya, "POST", "/api/auth/two-factor/disable", { password: "fourth-password-000" })).status).toBe(200);
    expect((await call(maya, "GET", "/api/me/security")).json.twoFactorEnabled).toBe(false);
  });

  it("email confirmation: a link from the signed-in person's own request confirms the address", async () => {
    // Setup and a hand-passed invite link don't confirm the address; an emailed invitation does.
    expect((await call(owner, "GET", "/api/me")).json.user.emailVerified).toBe(false);
    const users = (await call(owner, "GET", "/api/admin/users")).json as { email: string; emailVerified: boolean }[];
    expect(users.find((u) => u.email === "maya@acme.test")!.emailVerified).toBe(false);
    expect(users.find((u) => u.email === "ravi@acme.test")!.emailVerified).toBe(true);

    // Better Auth's public sender is closed; links come only from the signed-in endpoint.
    expect((await call(null, "POST", "/api/auth/send-verification-email", { email: "maya@acme.test" })).status).toBe(403);
    expect((await call(null, "POST", "/api/me/email/verify")).status).toBe(401);

    const maya = jar();
    await signIn(maya, "maya@acme.test", "fourth-password-000");
    expect((await call(maya, "GET", "/api/me")).json).toMatchObject({ emailEnabled: true, user: { emailVerified: false } });
    expect((await call(maya, "POST", "/api/me/email/verify")).json).toMatchObject({ ok: true, to: "maya@acme.test", expiresInHours: 24 });
    const m = await sink.next("maya@acme.test", "Confirm your email");
    const link = m.links.find((l) => l.startsWith("http://localhost:3000/api/auth/verify-email?token="))!;
    expect(link).toBeTruthy();

    // A tampered link fails and confirms nothing.
    const u = new URL(link);
    const bad = await app.inject({ method: "GET", url: `${u.pathname}?token=${u.searchParams.get("token")}x&callbackURL=${encodeURIComponent(u.searchParams.get("callbackURL")!)}` });
    expect(bad.statusCode).toBe(302);
    expect(String(bad.headers.location)).toContain("error=INVALID_TOKEN");
    expect((await call(maya, "GET", "/api/me")).json.user.emailVerified).toBe(false);

    // Opened in a browser that isn't signed in: confirms the address but doesn't sign anyone in.
    const ok = await app.inject({ method: "GET", url: u.pathname + u.search });
    expect(ok.statusCode).toBe(302);
    expect(ok.headers.location).toBe("/app?email_verified=1");
    expect(String(ok.headers["set-cookie"] ?? "")).not.toContain("session_token=");
    expect((await call(maya, "GET", "/api/me")).json.user.emailVerified).toBe(true);
    expect((await call(maya, "GET", "/api/me/security")).json).toMatchObject({ email: "maya@acme.test", emailVerified: true });
    expect((await call(maya, "POST", "/api/me/email/verify")).json).toEqual({ ok: true, alreadyVerified: true });
  });

  it("required two-step sign-in: password users get only the setup until they turn it on", async () => {
    // The admin has to have it first.
    const first = await call(owner, "PUT", "/api/admin/auth", { twoFactorRequired: true });
    expect(first.status).toBe(400);
    expect(first.json.error).toContain("your own account first");
    const en = await call(owner, "POST", "/api/auth/two-factor/enable", { password: "correct-horse-battery" });
    await call(owner, "POST", "/api/auth/two-factor/verify-totp", { code: totpCode(en.json.totpURI) });
    const on = await call(owner, "PUT", "/api/admin/auth", { twoFactorRequired: true });
    expect(on.json).toMatchObject({ twoFactorRequired: true, withoutTwoStep: 2 });
    expect((await call(owner, "GET", "/api/notifications")).status).toBe(200);

    const maya = jar();
    expect((await signIn(maya, "maya@acme.test", "fourth-password-000")).status).toBe(200);
    expect((await call(maya, "GET", "/api/me")).json.user.twoFactorSetupRequired).toBe(true);
    expect((await call(maya, "GET", "/api/me/security")).json).toMatchObject({ twoFactorRequired: true, twoFactorEnabled: false });
    const blocked = await call(maya, "GET", "/api/notifications");
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("two_factor_required");
    expect((await call(maya, "GET", `/api/workspaces/${workspaceId}/models`)).status).toBe(403);

    const mine = await call(maya, "POST", "/api/auth/two-factor/enable", { password: "fourth-password-000" });
    await call(maya, "POST", "/api/auth/two-factor/verify-totp", { code: totpCode(mine.json.totpURI) });
    expect((await call(maya, "GET", "/api/me")).json.user.twoFactorSetupRequired).toBe(false);
    expect((await call(maya, "GET", "/api/notifications")).status).toBe(200);
    expect((await call(owner, "GET", "/api/admin/auth")).json.withoutTwoStep).toBe(1);

    // While the rule is on, it can't be turned off by the person.
    const off = await call(maya, "POST", "/api/auth/two-factor/disable", { password: "fourth-password-000" });
    expect(off.status).toBe(403);
    expect(off.json.code).toBe("two_factor_required");

    // With single sign-on required, people who can't use a password aren't asked.
    const ravi = jar();
    await signIn(ravi, "ravi@acme.test", "first-password-123");
    expect((await call(ravi, "GET", "/api/me")).json.user.twoFactorSetupRequired).toBe(true);
    await db.execute(sql`update organization set sso_required = true`);
    expect((await call(ravi, "GET", "/api/me")).json.user.twoFactorSetupRequired).toBe(false);
    expect((await call(ravi, "GET", "/api/notifications")).status).toBe(200);
    expect((await call(owner, "GET", "/api/admin/auth")).json.withoutTwoStep).toBe(0);
    await db.execute(sql`update organization set sso_required = false`);

    expect((await call(maya, "PUT", "/api/admin/auth", { twoFactorRequired: false })).status).toBe(403);
    expect((await call(owner, "PUT", "/api/admin/auth", { twoFactorRequired: false })).json.twoFactorRequired).toBe(false);
    expect((await call(ravi, "GET", "/api/notifications")).status).toBe(200);
    expect((await call(maya, "POST", "/api/auth/two-factor/disable", { password: "fourth-password-000" })).status).toBe(200);
    const actions = (await db.execute(sql`select action from audit_log`)) as unknown as { action: string }[];
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["user.email_verified", "auth.two_factor_required_on", "auth.two_factor_required_off"]));
  });
});
