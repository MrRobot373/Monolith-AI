/** Single sign-on end to end against a mock OpenID provider. */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMockIdp } from "../test/mock-idp.mjs";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

d("Single sign-on", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let idp: Awaited<ReturnType<typeof startMockIdp>>;
  const owner = jar();
  let workspaceId = "";
  let connId = "";

  function absorb(j: Jar, set: string | string[] | undefined) {
    if (!set) return;
    const map = new Map(j.cookie.split("; ").filter(Boolean).map((c) => c.split("=") as [string, string]));
    for (const c of Array.isArray(set) ? set : [set]) {
      const [k, ...v] = c.split(";")[0]!.split("=");
      map.set(k!, v.join("="));
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

  /** Walk the whole browser redirect dance. Returns the final redirect or the error shown to the user. */
  async function ssoLogin(email: string, j: Jar = jar(), opts: { next?: string; tamperState?: boolean; dropCookie?: boolean; id?: string } = {}) {
    const start = await app.inject({ method: "GET", url: `/api/auth/sso/${opts.id ?? connId}/start?email=${encodeURIComponent(email)}&next=${encodeURIComponent(opts.next ?? "/app")}` });
    const loc = String(start.headers.location);
    if (loc.startsWith("/")) return { error: new URL(loc, APP_URL).searchParams.get("sso_error"), j };
    const stateCookie = String(start.headers["set-cookie"]).split(";")[0]!;
    const atIdp = await fetch(loc, { redirect: "manual" });
    const back = new URL(atIdp.headers.get("location")!);
    if (opts.tamperState) back.searchParams.set("state", "forged");
    // Through a proxy: the client's own claim (left), then the address the web app's proxy saw (right).
    const cb = await app.inject({ method: "GET", url: back.pathname + back.search, headers: { "x-forwarded-for": "6.6.6.6, 203.0.113.9", ...(opts.dropCookie ? {} : { cookie: stateCookie }) } });
    const next = String(cb.headers.location);
    if (!next.startsWith("/api/auth/sso/ticket")) return { error: new URL(next, APP_URL).searchParams.get("sso_error"), j };
    const t = await app.inject({ method: "GET", url: next, headers: { origin: APP_URL, "x-forwarded-for": "6.6.6.6, 203.0.113.9" } });
    absorb(j, t.headers["set-cookie"]);
    return { location: String(t.headers.location), j, ticketUrl: next };
  }

  beforeAll(async () => {
    idp = await startMockIdp();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: "test-secret-test-secret-test-secret-1234", allowMockProvider: true, port: 0, storageDir: "" };
    app = await buildApp(db, cfg);
    await call(owner, "POST", "/api/setup", { orgName: "Acme", name: "Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
    await idp?.close();
  });

  it("an admin adds an OIDC provider; the sign-in page lists it", async () => {
    expect((await call(owner, "POST", "/api/admin/sso", { type: "microsoft", tenantId: "common", clientId: "x", clientSecret: "y" })).status).toBe(400);
    expect((await call(owner, "POST", "/api/admin/sso", { type: "oidc", issuer: "http://example.com", clientId: "x", clientSecret: "y" })).json.error).toContain("https");
    expect((await call(owner, "POST", "/api/admin/sso", { type: "oidc", issuer: idp.issuer, clientId: "x", clientSecret: "y", autoJoin: true })).status).toBe(400);
    const r = await call(owner, "POST", "/api/admin/sso", { type: "oidc", name: "Okta", issuer: idp.issuer, clientId: idp.clientId, clientSecret: idp.clientSecret, domains: ["@Acme.test"] });
    expect(r.status).toBe(200);
    expect(r.json.clientSecretEnc).toBeUndefined();
    expect(r.json.domains).toEqual(["acme.test"]);
    connId = r.json.id;
    expect((await call(null, "GET", "/api/public/sso")).json).toEqual([{ id: connId, type: "oidc", name: "Okta" }]);
    expect((await call(owner, "POST", `/api/admin/sso/${connId}/test`)).json.ok).toBe(true);
    const g = await call(owner, "POST", "/api/admin/sso", { type: "google", clientId: "g.apps.googleusercontent.com", clientSecret: "s", enabled: false });
    expect(g.json).toMatchObject({ name: "Google", issuer: "https://accounts.google.com", enabled: false });
    // The desktop app learns where sign-in may take its windows (enabled providers only).
    expect((await call(null, "GET", "/api/public/desktop")).json).toEqual({
      product: "aatmiq",
      name: "Aatmiq",
      appOrigin: APP_URL,
      ideOrigin: null,
      signInOrigins: [new URL(idp.issuer).origin],
    });
  });

  it("people without an account or invitation are turned away", async () => {
    const r = await ssoLogin("stranger@acme.test");
    expect(r.error).toContain("no account for stranger@acme.test");
  });

  it("an invited person signs in with SSO and joins their workspaces", async () => {
    await call(owner, "POST", "/api/admin/invites", { email: "dev@acme.test", workspaces: [{ workspaceId, role: "member" }] });
    const r = await ssoLogin("dev@acme.test", jar(), { next: "/app/chat" });
    expect(r.location).toBe("/app/chat");
    const me = await call(r.j, "GET", "/api/me");
    expect(me.json.user).toMatchObject({ email: "dev@acme.test", name: "dev", orgRole: "member" });
    expect(me.json.workspaces[0].id).toBe(workspaceId);
    // The invitation is used up.
    expect((await call(owner, "GET", "/api/admin/invites")).json).toHaveLength(0);
  });

  it("signing in again reuses the same account; tickets work once", async () => {
    const r = await ssoLogin("dev@acme.test");
    const { n } = (await db.execute(sql`select count(*)::int as n from "user" where email = 'dev@acme.test'`))[0] as { n: number };
    expect(n).toBe(1);
    const again = await app.inject({ method: "GET", url: r.ticketUrl! });
    expect(String(again.headers.location)).toContain("sso_error");
  });

  it("links an existing password account by email", async () => {
    const r = await ssoLogin("owner@acme.test");
    expect((await call(r.j, "GET", "/api/me")).json.user.orgRole).toBe("owner");
  });

  it("rejects other domains, unverified emails, forged state and wrong secrets", async () => {
    expect((await ssoLogin("eve@evil.test")).error).toContain("can't sign in here");
    expect((await ssoLogin("dev@acme.test", jar(), { tamperState: true })).error).toContain("expired");
    expect((await ssoLogin("dev@acme.test", jar(), { dropCookie: true })).error).toContain("expired");
    idp.state.emailVerified = false;
    expect((await ssoLogin("dev@acme.test")).error).toContain("isn't verified");
    idp.state.emailVerified = true;
    await call(owner, "PATCH", `/api/admin/sso/${connId}`, { clientSecret: "wrong" });
    expect((await ssoLogin("dev@acme.test")).error).toContain("Wrong client secret");
    await call(owner, "PATCH", `/api/admin/sso/${connId}`, { clientSecret: idp.clientSecret });
  });

  it("auto-join creates members for allowed domains", async () => {
    await call(owner, "PATCH", `/api/admin/sso/${connId}`, { autoJoin: true });
    const r = await ssoLogin("new.person@acme.test");
    expect(r.error ?? null).toBeNull();
    const me = (await call(r.j, "GET", "/api/me")).json;
    expect(me.user.orgRole).toBe("member");
    expect(me.workspaces.map((w: { id: string }) => w.id)).toEqual([workspaceId]);
    const audit = (await call(owner, "GET", "/api/admin/audit")).json.map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(["user.sso_created", "auth.sso_login", "auth.sso_added"]));
    // The audit log has the address the proxy in front saw, not the one the client claimed.
    const ips = (await db.execute(sql`select distinct ip from audit_log where action = 'auth.sso_login'`)) as unknown as { ip: string }[];
    expect(ips.map((x) => x.ip)).toEqual(["203.0.113.9"]);
  });

  it("deactivated people can't sign in with SSO", async () => {
    const users = (await call(owner, "GET", "/api/admin/users")).json;
    const dev = users.find((u: { email: string }) => u.email === "dev@acme.test");
    await call(owner, "PATCH", `/api/admin/users/${dev.id}`, { status: "deactivated" });
    expect((await ssoLogin("dev@acme.test")).error).toContain("deactivated");
    await call(owner, "PATCH", `/api/admin/users/${dev.id}`, { status: "active" });
  });

  it("requiring SSO blocks passwords for everyone but the owner", async () => {
    const inv = await call(owner, "POST", "/api/admin/invites", { email: "pw@acme.test", workspaces: [{ workspaceId, role: "member" }] });
    const pw = jar();
    await call(pw, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name: "Pat", password: "another-good-password" });
    expect((await call(owner, "PUT", "/api/admin/auth", { ssoRequired: true })).json.ssoRequired).toBe(true);
    expect((await call(null, "GET", "/api/public/status")).json.ssoRequired).toBe(true);
    const blocked = await call(jar(), "POST", "/api/auth/sign-in/email", { email: "pw@acme.test", password: "another-good-password" });
    expect(blocked.json.code).toBe("sso_required");
    expect((await call(jar(), "POST", "/api/auth/sign-in/email", { email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    // Turning off the only provider turns the requirement off too.
    await call(owner, "PATCH", `/api/admin/sso/${connId}`, { enabled: false });
    expect((await call(owner, "GET", "/api/admin/auth")).json.ssoRequired).toBe(false);
    expect((await ssoLogin("dev@acme.test")).error).toContain("isn't available");
  });
});
