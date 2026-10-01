/** License server API against a real Postgres (LICENSE_TEST_DATABASE_URL). */
import { DAY_MS, generateSigningKeys, importPrivateKey, importPublicKey, signLicense, verifyLicense } from "@aatmiq/license";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { createDb, type LDB } from "./db";
import { loadSigningKeys } from "./keys";
import { runMigrations } from "./migrate";

const url = process.env.LICENSE_TEST_DATABASE_URL;
const d = url ? describe : describe.skip;

const cfg: Config = {
  databaseUrl: url ?? "",
  secret: "license-test-secret-license-test-secret",
  port: 0,
  consoleUrl: "http://localhost:3100",
  signingKeyPem: null,
  bootstrapAdmin: { email: "root@aatmiq.test", password: "super-secret-password", name: "Root" },
};

d("license server", () => {
  let app: FastifyInstance;
  let db: LDB;
  let close: () => Promise<void>;
  let cookie = "";
  let customerId = "";
  let lic: { id: string; token: string } = { id: "", token: "" };

  async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown, opts: { csrf?: boolean; auth?: boolean } = {}) {
    const res = await app.inject({
      method,
      url: path,
      headers: {
        ...(opts.auth === false ? {} : { cookie }),
        ...(opts.csrf === false ? {} : { "x-aatmiq-console": "1" }),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set[0]! : set).split(";")[0]!;
    return { status: res.statusCode, json: res.body ? res.json() : null };
  }

  beforeAll(async () => {
    await runMigrations(url!);
    ({ db, close } = createDb(url!));
    await db.execute(sql`truncate admin_user, admin_session, signing_key, customer, license, check_in, setting, admin_audit cascade`);
    const keys = await loadSigningKeys(db, cfg);
    app = await buildApp(db, cfg, keys);
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("creates the first Super Admin from the environment and signs in", async () => {
    expect((await call("GET", "/api/me")).status).toBe(401);
    expect((await call("POST", "/api/auth/login", { email: "root@aatmiq.test", password: "wrong-password" })).status).toBe(401);
    const r = await call("POST", "/api/auth/login", { email: "ROOT@aatmiq.test", password: "super-secret-password" });
    expect(r.status).toBe(200);
    expect((await call("GET", "/api/me")).json.email).toBe("root@aatmiq.test");
  });

  it("requires the console header for changes", async () => {
    expect((await call("POST", "/api/customers", { name: "x" }, { csrf: false })).status).toBe(403);
  });

  it("issues a license whose key verifies offline with the published public key", async () => {
    customerId = (await call("POST", "/api/customers", { name: "Acme Labs", contactEmail: "it@acme.test" })).json.id;
    const r = await call("POST", `/api/customers/${customerId}/licenses`, {
      tier: "work",
      seats: 25,
      expiresAt: new Date(Date.now() + 365 * DAY_MS).toISOString(),
      accent: "#22D3EE",
    });
    expect(r.status).toBe(200);
    lic = r.json;
    const { publicKey } = (await call("GET", "/api/settings")).json;
    const claims = await verifyLicense(lic.token, await importPublicKey(publicKey));
    expect(claims).toMatchObject({ lid: lic.id, customer: "Acme Labs", tier: "work", seats: 25, sections: ["chat", "work"], branding: { accent: "#22D3EE" } });
    expect((await call("POST", `/api/customers/${customerId}/licenses`, { tier: "chat", seats: 5, expiresAt: "2020-01-01" })).status).toBe(400);
  });

  it("accepts check-ins with counts only and returns the latest key and release", async () => {
    await call("PUT", "/api/settings/release", { version: "1.2.0", notes: "Faster search" });
    const ci = await call("POST", "/v1/check-in", {
      token: lic.token,
      instanceId: "instance-aaaa-1111",
      version: "1.1.0",
      activeSeats: 12,
      usage: [{ section: "chat", inputTokens: 1000, outputTokens: 500, requests: 20 }],
    }, { auth: false, csrf: false });
    expect(ci.status).toBe(200);
    expect(ci.json).toMatchObject({ status: "active", token: lic.token, release: { version: "1.2.0" } });
    const detail = (await call("GET", `/api/customers/${customerId}`)).json;
    expect(detail.licenses[0]).toMatchObject({ activeSeats: 12, lastVersion: "1.1.0", instanceId: "instance-aaaa-1111" });
    expect(detail.checkIns[0].usage[0].inputTokens).toBe(1000);
  });

  it("changing seats re-signs the key; the deployment receives it at check-in", async () => {
    const r = await call("PATCH", `/api/licenses/${lic.id}`, { seats: 40 });
    expect(r.json.token).not.toBe(lic.token);
    const ci = await call("POST", "/v1/check-in", { token: lic.token, instanceId: "instance-aaaa-1111", activeSeats: 12 }, { auth: false, csrf: false });
    const { publicKey } = (await call("GET", "/api/settings")).json;
    expect((await verifyLicense(ci.json.token, await importPublicKey(publicKey))).seats).toBe(40);
  });

  it("flags a second deployment using the same key", async () => {
    await call("POST", "/v1/check-in", { token: lic.token, instanceId: "instance-bbbb-2222", activeSeats: 3 }, { auth: false, csrf: false });
    const ov = await call("GET", "/api/overview");
    if (ov.status !== 200) throw new Error(JSON.stringify(ov.json));
    const o = ov.json;
    expect(o.attention.find((x: { id: string }) => x.id === lic.id).instanceConflict).toBe(true);
    expect(o).toMatchObject({ customers: 1, activeLicenses: 1, seatsSold: 40 });
    expect(o.tokensDaily).toHaveLength(30);
    expect(o.tokensDaily.at(-1)).toMatchObject({ input: 1000, output: 500 });
  });

  it("rejects forged keys and reports revoked licenses", async () => {
    const other = await generateSigningKeys();
    const forged = await signLicense(
      { lid: lic.id, cid: customerId, customer: "Acme", tier: "enterprise", seats: 9999, sections: ["chat"], features: [], modelMode: "self", workspaceLimit: null, checkInHours: 24 },
      { privateKey: await importPrivateKey(other.privatePem), kid: "fake", expiresAt: new Date(Date.now() + DAY_MS) },
    );
    expect((await call("POST", "/v1/check-in", { token: forged, instanceId: "instance-aaaa-1111", activeSeats: 1 }, { auth: false, csrf: false })).status).toBe(401);
    await call("POST", `/api/licenses/${lic.id}/revoke`);
    const ci = await call("POST", "/v1/check-in", { token: lic.token, instanceId: "instance-aaaa-1111", activeSeats: 1 }, { auth: false, csrf: false });
    expect(ci.json).toEqual({ status: "revoked" });
    expect((await call("DELETE", `/api/customers/${customerId}`)).status).toBe(200);
  });

  it("keeps an audit trail and signs out", async () => {
    const a = (await call("GET", "/api/audit")).json.map((x: { action: string }) => x.action);
    expect(a).toEqual(expect.arrayContaining(["admin.login", "license.issued", "license.updated", "license.revoked", "release.published"]));
    await call("POST", "/api/auth/logout");
    expect((await call("GET", "/api/me")).status).toBe(401);
  });
});
