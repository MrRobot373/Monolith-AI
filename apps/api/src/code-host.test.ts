/**
 * The IDE on its own host (IDE_URL): one-time handoff, the IDE host serving only the IDE, sessions
 * tied to Aatmiq's, and Aatmiq refusing writes from other origins.
 * Needs the IDE build (pnpm --filter @aatmiq/code build) and TEST_DATABASE_URL.
 */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { request } from "node:http";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadIdeUrl, type Config } from "./config";
import { codeDistDir } from "./services/code";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const IDE_URL = "http://ide.test";

describe("IDE_URL", () => {
  it("must be just an address on another host", () => {
    expect(loadIdeUrl("https://ide.acme.com/", "https://ai.acme.com")).toBe("https://ide.acme.com");
    expect(loadIdeUrl(undefined, "https://ai.acme.com")).toBeNull();
    expect(() => loadIdeUrl("https://ai.acme.com", "https://ai.acme.com/")).toThrow("different hostname");
    expect(() => loadIdeUrl("https://ide.acme.com/code", "https://ai.acme.com")).toThrow("without a path");
    expect(() => loadIdeUrl("ide.acme.com", "https://ai.acme.com")).toThrow("full address");
  });
});

const d = url && existsSync(join(codeDistDir(), "out", "server-main.js")) ? describe : describe.skip;

d("the IDE on its own host", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let base = "";
  let appCookie = "";
  let codeId = "";

  /** A raw request so the Host header can be set. */
  function hit(path: string, opts: { host?: string; cookie?: string; accept?: string; method?: string; origin?: string; body?: string; ws?: boolean } = {}) {
    return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }>((resolve, reject) => {
      const u = new URL(base);
      const req = request({
        host: u.hostname,
        port: u.port,
        path,
        method: opts.method ?? "GET",
        headers: {
          host: opts.host ?? "localhost:3000",
          ...(opts.cookie ? { cookie: opts.cookie } : {}),
          ...(opts.accept ? { accept: opts.accept } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.body ? { "content-type": "application/json" } : {}),
          ...(opts.ws ? { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } : {}),
        },
      });
      req.on("upgrade", (res, socket) => {
        socket.destroy();
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: "" });
      });
      req.on("response", (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      req.on("error", reject);
      req.end(opts.body);
    });
  }
  const openUrl = async () => JSON.parse((await hit(`/api/code/workspaces/${codeId}/open`, { method: "POST", cookie: appCookie, origin: APP_URL, body: "{}" })).body).url as string;

  beforeAll(async () => {
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = {
      appUrl: APP_URL,
      databaseUrl: url!,
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: true,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-work-")),
      codeDir: await mkdtemp(join(tmpdir(), "aatmiq-code-")),
      ideUrl: IDE_URL,
    };
    app = await buildApp(db, cfg);
    base = await app.listen({ port: 0, host: "127.0.0.1" });
    const setup = await hit("/api/setup", { method: "POST", origin: APP_URL, body: JSON.stringify({ orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" }) });
    appCookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const me = JSON.parse((await hit("/api/me", { cookie: appCookie })).body);
    const w = await hit("/api/code/workspaces", { method: "POST", cookie: appCookie, origin: APP_URL, body: JSON.stringify({ workspaceId: me.workspaces[0].id, name: "Billing" }) });
    codeId = JSON.parse(w.body).id;
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await close?.();
  }, 60_000);

  it("Aatmiq no longer serves the IDE; the IDE host serves nothing else", async () => {
    const moved = await hit("/code/ide/", { cookie: appCookie });
    expect(moved.status).toBe(404);
    expect(moved.body).toContain("The editor is at http://ide.test");
    for (const p of ["/api/me", "/", "/app/chat", "/api/auth/get-session"]) expect((await hit(p, { host: "ide.test" })).status).toBe(404);
    expect((await hit("/api/health", { host: "ide.test" })).status).toBe(200);
    // The web app's proxy passes the original host on.
    expect((await hit("/api/me", { host: "web:3000", cookie: appCookie })).status).toBe(200);
    const viaWeb = await new Promise<number>((resolve) => {
      const u = new URL(base);
      request({ host: u.hostname, port: u.port, path: "/api/me", headers: { host: "api:4000", "x-forwarded-host": "ide.test" } }, (r) => resolve(r.statusCode ?? 0)).end();
    });
    expect(viaWeb).toBe(404);
  });

  it("an Aatmiq session doesn't open the IDE on its host; a one-time ticket does", async () => {
    const page = await hit("/code/ide/", { host: "ide.test", cookie: appCookie, accept: "text/html" });
    expect(page.status).toBe(401);
    expect(page.body).toContain("Open your workspace from Aatmiq");

    const link = await openUrl();
    expect(link.startsWith("http://ide.test/code/ide/__aatmiq/session?ticket=")).toBe(true);
    const path = link.slice(IDE_URL.length);
    const r = await hit(path, { host: "ide.test" });
    expect(r.status).toBe(302);
    expect(r.headers.location).toMatch(/^\/code\/ide\/\?folder=/);
    const set = String(r.headers["set-cookie"]);
    expect(set).toMatch(/^aatmiq_ide=[^;]+; Path=\/code\/ide; HttpOnly; Max-Age=43200; SameSite=Lax$/);
    // Used once.
    expect((await hit(path, { host: "ide.test" })).status).toBe(401);
    // A crafted "next" can't send the browser elsewhere.
    const evil = (await openUrl()).slice(IDE_URL.length).replace(/next=[^&]*/, "next=https%3A%2F%2Fevil.example");
    expect((await hit(evil, { host: "ide.test" })).headers.location).toBe("/code/ide/");

    const ideCookie = set.split(";")[0]!;
    const ide = await hit(String(r.headers.location), { host: "ide.test", cookie: ideCookie });
    expect(ide.status).toBe(200);
    expect(ide.body).toContain('apple-mobile-web-app-title" content="Aatmiq Code"');
    // The IDE host's cookie means nothing to Aatmiq.
    expect((await hit("/api/me", { cookie: ideCookie })).status).toBe(401);

    // WebSockets: only from the IDE host itself.
    const ws = "/code/ide/?reconnectionToken=t1&reconnection=false&skipWebSocketFrames=false";
    expect((await hit(ws, { host: "ide.test", cookie: ideCookie, origin: IDE_URL, ws: true })).status).toBe(101);
    expect((await hit(ws, { host: "ide.test", cookie: ideCookie, origin: APP_URL, ws: true })).status).toBe(403);
    // On Aatmiq's own host the IDE's connections are dropped outright.
    expect((await hit(ws, { cookie: appCookie, origin: APP_URL, ws: true }).catch(() => ({ status: 0 }))).status).toBe(0);
  }, 60_000);

  it("signing out of Aatmiq ends the IDE host's session too", async () => {
    const r = await hit((await openUrl()).slice(IDE_URL.length), { host: "ide.test" });
    const ideCookie = String(r.headers["set-cookie"]).split(";")[0]!;
    expect((await hit("/code/ide/", { host: "ide.test", cookie: ideCookie })).status).toBe(200);
    expect((await hit("/api/auth/sign-out", { method: "POST", cookie: appCookie, origin: APP_URL, body: "{}" })).status).toBe(200);
    // Sessions are cached for 30 seconds.
    await new Promise((res) => setTimeout(res, 31_000));
    expect((await hit("/code/ide/", { host: "ide.test", cookie: ideCookie })).status).toBe(401);
  }, 60_000);

  it("Aatmiq refuses changes from other origins, the IDE host included", async () => {
    const signIn = await hit("/api/auth/sign-in/email", { method: "POST", origin: APP_URL, body: JSON.stringify({ email: "owner@acme.test", password: "correct-horse-battery" }) });
    const cookie = String(signIn.headers["set-cookie"]).split(";")[0]!;
    const body = JSON.stringify({ name: "x" });
    for (const origin of [IDE_URL, "https://evil.example", "null"]) {
      const r = await hit("/api/me", { method: "PATCH" as never, cookie, origin, body });
      expect(r.status).toBe(403);
      expect(JSON.parse(r.body).code).toBe("bad_origin");
    }
    expect((await hit("/api/me", { method: "PATCH", cookie, origin: APP_URL, body: JSON.stringify({ jobTitle: "Owner" }) })).status).toBe(200);
    // Server-to-server calls carry no Origin and still work.
    expect((await hit("/api/me", { method: "PATCH", cookie, body: JSON.stringify({ jobTitle: "Owner" }) })).status).toBe(200);
  });
});
