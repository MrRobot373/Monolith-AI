/** Licensed mode: setup with a key, seats, sections, workspace limit, check-ins, revocation, grace. */
import { DAY_MS, generateSigningKeys, importPrivateKey, signLicense, type LicenseTerms } from "@aatmiq/license";
import { createDb, licenseState, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

d("Licensed deployment", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let cookie = "";
  let mint: (t: Partial<LicenseTerms>, exp?: number) => Promise<string>;
  let forged = "";
  // The fake license server: records check-ins and answers with `reply`.
  const checkIns: Record<string, unknown>[] = [];
  let reply: Record<string, unknown> = { status: "active" };

  async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json = null;
    try {
      json = res.body ? res.json() : null;
    } catch {
      json = res.body; // streamed replies
    }
    return { status: res.statusCode, json };
  }
  const waitFor = async (fn: () => boolean) => {
    for (let i = 0; i < 50 && !fn(); i++) await new Promise((r) => setTimeout(r, 50));
  };

  beforeAll(async () => {
    const keys = await generateSigningKeys();
    const priv = await importPrivateKey(keys.privatePem);
    const base: LicenseTerms = { lid: "lic_test", cid: "cus_test", customer: "Acme Labs", tier: "chat", seats: 2, sections: ["chat"], features: ["sso"], modelMode: "self", workspaceLimit: 2, branding: { accent: "#A78BFA" }, checkInHours: 24 };
    mint = (t, exp = 365) => signLicense({ ...base, ...t }, { privateKey: priv, kid: "k1", expiresAt: new Date(Date.now() + exp * DAY_MS), issuedAt: new Date(Date.now() - DAY_MS) });
    const other = await generateSigningKeys();
    forged = await signLicense({ ...base, seats: 999 }, { privateKey: await importPrivateKey(other.privatePem), kid: "x", expiresAt: new Date(Date.now() + DAY_MS) });

    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = {
      appUrl: APP_URL,
      databaseUrl: url!,
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: true,
      port: 0,
      storageDir: "",
      licensePublicKey: keys.publicPem,
      licenseServerUrl: "http://license.test",
      version: "9.9.9",
    };
    const fakeFetch = (async (_u: string | URL | Request, init?: RequestInit) => {
      checkIns.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(reply), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    app = await buildApp(db, cfg, { fetch: fakeFetch });
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("needs a genuine key to set up", async () => {
    expect((await call("GET", "/api/public/status")).json.licenseRequired).toBe(true);
    const owner = { orgName: "Acme Labs", name: "Owner", email: "o@lic.test", password: "correct-horse-battery" };
    expect((await call("POST", "/api/setup", owner)).status).toBe(400);
    const bad = await call("POST", "/api/setup", { ...owner, licenseKey: forged });
    expect(bad.json.error).toContain("wasn't issued by Aatmiq");
    const key = await mint({});
    expect((await call("POST", "/api/public/license/preview", { key })).json).toMatchObject({ customer: "Acme Labs", seats: 2, accent: "#A78BFA" });
    expect((await call("POST", "/api/setup", { ...owner, licenseKey: key })).status).toBe(200);
    const me = (await call("GET", "/api/me")).json;
    expect(me.org.accentColor).toBe("#A78BFA");
    expect(me.license).toMatchObject({ state: "valid", canUse: true, tier: "chat", sections: ["chat"] });
  });

  it("checks in with counts only", async () => {
    await waitFor(() => checkIns.length > 0);
    const c = checkIns[0]!;
    expect(Object.keys(c).sort()).toEqual(["activeSeats", "health", "instanceId", "token", "usage", "version"]);
    expect(c).toMatchObject({ activeSeats: 1, version: "9.9.9" });
    const lic = (await call("GET", "/api/admin/license")).json;
    expect(lic.checkIn.lastCheckInAt).toBeTruthy();
    expect(lic.license).toMatchObject({ seats: 2, tierLabel: "Chat" });
  });

  it("enforces seats, counting pending invitations", async () => {
    const me = (await call("GET", "/api/me")).json;
    const ws = [{ workspaceId: me.workspaces[0].id, role: "member" }];
    expect((await call("POST", "/api/admin/invites", { email: "a@lic.test", workspaces: ws })).status).toBe(200);
    // Re-inviting the same person doesn't take another seat.
    expect((await call("POST", "/api/admin/invites", { email: "a@lic.test", workspaces: ws })).status).toBe(200);
    const full = await call("POST", "/api/admin/invites", { email: "b@lic.test", workspaces: ws });
    expect(full.status).toBe(402);
    expect(full.json.code).toBe("seat_limit");
  });

  it("enforces the plan's workspace limit", async () => {
    expect((await call("POST", "/api/admin/workspaces", { name: "Second" })).status).toBe(200);
    expect((await call("POST", "/api/admin/workspaces", { name: "Third" })).json.code).toBe("workspace_limit");
  });

  it("picks up a renewed key (more seats) at check-in", async () => {
    reply = { status: "active", token: await mint({ seats: 5 }), release: { version: "10.0.0", notes: "New things", url: null } };
    const r = (await call("POST", "/api/admin/license/check-in")).json;
    expect(r.license.seats).toBe(5);
    expect(r.release.version).toBe("10.0.0");
    const me = (await call("GET", "/api/me")).json;
    expect((await call("POST", "/api/admin/invites", { email: "b@lic.test", workspaces: [{ workspaceId: me.workspaces[0].id, role: "member" }] })).status).toBe(200);
    // A renewed key for a different license is ignored.
    reply = { status: "active", token: await mint({ lid: "someone-else", seats: 500 }) };
    expect((await call("POST", "/api/admin/license/check-in")).json.license.seats).toBe(5);
  });

  it("revoked: people can read but not send; a new key restores it", async () => {
    const me = (await call("GET", "/api/me")).json;
    const chat = (await call("POST", "/api/chats", { workspaceId: me.workspaces[0].id })).json;
    reply = { status: "revoked" };
    await call("POST", "/api/admin/license/check-in");
    expect((await call("GET", "/api/me")).json.license).toMatchObject({ state: "revoked", canUse: false });
    const blocked = await call("POST", `/api/chats/${chat.id}/messages`, { content: "hi" });
    expect(blocked.status).toBe(402);
    expect(blocked.json.code).toBe("license_inactive");
    expect((await call("GET", `/api/chats?workspaceId=${me.workspaces[0].id}`)).status).toBe(200);
    expect((await call("PUT", "/api/admin/license", { key: forged })).status).toBe(400);
    reply = { status: "active" };
    expect((await call("PUT", "/api/admin/license", { key: await mint({ seats: 5 }) })).json.state).toBe("valid");
    expect((await call("POST", `/api/chats/${chat.id}/messages`, { content: "hi" })).status).toBe(200);
  });

  it("expired: 14 days of grace, then stopped", async () => {
    await call("PUT", "/api/admin/license", { key: await mint({ seats: 5 }, -3) });
    const grace = (await call("GET", "/api/me")).json.license;
    expect(grace).toMatchObject({ state: "expiring_grace", canUse: true });
    expect(grace.message).toContain("11 days");
    await call("PUT", "/api/admin/license", { key: await mint({ seats: 5 }, -20) });
    expect((await call("GET", "/api/me")).json.license.canUse).toBe(false);
    await call("PUT", "/api/admin/license", { key: await mint({ seats: 5 }) });
  });

  it("no check-in for 30 days pauses admin changes, not chat", async () => {
    // Let the check-in started by the last key change finish first.
    const n = checkIns.length;
    await waitFor(() => checkIns.length > n);
    await new Promise((r) => setTimeout(r, 200));
    await db.update(licenseState).set({ lastCheckInAt: new Date(Date.now() - 40 * DAY_MS) });
    const locked = await call("PUT", "/api/admin/settings", { loginMessage: "hello" });
    expect(locked.json.code).toBe("license_admin_locked");
    const me = (await call("GET", "/api/me")).json;
    expect((await call("POST", "/api/chats", { workspaceId: me.workspaces[0].id })).status).toBe(200);
    // Checking in clears it.
    await call("POST", "/api/admin/license/check-in");
    expect((await call("PUT", "/api/admin/settings", { loginMessage: "hello" })).status).toBe(200);
  });
});
