/**
 * Aatmiq Code through the API: workspaces, the per-person IDE server and the /code/ide proxy.
 * Needs the IDE build (pnpm --filter @aatmiq/code build) and TEST_DATABASE_URL.
 */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { execFileSync } from "node:child_process";
import { request } from "node:http";
import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { codeDistDir } from "./services/code";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url && existsSync(join(codeDistDir(), "out", "server-main.js")) ? describe : describe.skip;

let app: FastifyInstance;
let db: DB;
let close: () => Promise<void>;
let apiUrl = "";
let codeDir = "";
const owner = { cookie: "" };

async function call(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
  const res = await app.inject({
    method,
    url: path,
    headers: { origin: APP_URL, ...(owner.cookie ? { cookie: owner.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers["set-cookie"];
  if (set) owner.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, body: res.body };
}

/** Open a WebSocket through the proxy; resolves with the HTTP status of the handshake. */
function wsStatus(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const u = new URL(path, apiUrl);
    const req = request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers },
    });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(res.statusCode ?? 0);
    });
    req.on("response", (res) => resolve(res.statusCode ?? 0));
    req.on("error", reject);
    req.end();
  });
}

d("Aatmiq Code", () => {
  let workspaceId = "";
  let codeId = "";
  let openUrl = "";

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
      databaseUrl: url ?? "",
      secret: "test-secret-test-secret-test-secret-1234",
      allowMockProvider: true,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-work-")),
      codeDir: (codeDir = await mkdtemp(join(tmpdir(), "aatmiq-code-"))),
    };
    app = await buildApp(db, cfg);
    apiUrl = await app.listen({ port: 0, host: "127.0.0.1" });
    expect((await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    workspaceId = (await call("GET", "/api/me")).json.workspaces[0].id;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
  }, 60_000);

  it("creates workspaces with unique folders", async () => {
    const a = await call("POST", "/api/code/workspaces", { workspaceId, name: "Billing Service" });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ slug: "billing-service", status: "ready" });
    const b = await call("POST", "/api/code/workspaces", { workspaceId, name: "billing service" });
    expect(b.json.slug).toBe("billing-service-2");
    expect(existsSync(a.json.path)).toBe(true);
    codeId = a.json.id;
    expect((await call("POST", "/api/code/workspaces", { workspaceId, name: "x", gitUrl: "file:///etc" })).status).toBe(400);
    expect((await call("GET", `/api/code/workspaces?workspaceId=${workspaceId}`)).json).toHaveLength(2);
  });

  it("opens the IDE through the proxy, only with a session", async () => {
    const o = await call("POST", `/api/code/workspaces/${codeId}/open`);
    expect(o.status).toBe(200);
    openUrl = o.json.url;
    expect(openUrl).toMatch(/^\/code\/ide\/\?folder=/);
    const page = await fetch(`${apiUrl}${openUrl}`, { headers: { cookie: owner.cookie } });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('apple-mobile-web-app-title" content="Aatmiq Code"');
    const anon = await fetch(`${apiUrl}${openUrl}`, { redirect: "manual", headers: { accept: "text/html" } });
    expect(anon.status).toBe(302);
    expect((await fetch(`${apiUrl}/code/ide/`)).status).toBe(401);
    expect((await call("GET", "/api/code/status")).json).toMatchObject({ installed: true, running: true, allowed: true });
  }, 60_000);

  it("guards WebSocket upgrades: session and same origin", async () => {
    const path = "/code/ide/?reconnectionToken=t1&reconnection=false&skipWebSocketFrames=false";
    expect(await wsStatus(path, {})).toBe(401);
    expect(await wsStatus(path, { cookie: owner.cookie, origin: "https://evil.example" })).toBe(403);
    expect(await wsStatus(path, { cookie: owner.cookie, origin: APP_URL })).toBe(101);
  }, 30_000);

  it.runIf(process.getuid?.() === 0)("runs the IDE as the person's own Unix user in a private home", async () => {
    const home = join(codeDir, (await call("GET", "/api/me")).json.user.id);
    const st = statSync(home);
    expect(st.uid).toBeGreaterThanOrEqual(100000);
    expect(st.mode & 0o777).toBe(0o700);
    const pids = execFileSync("ps", ["-eo", "uid,args"]).toString();
    expect(pids).toMatch(new RegExp(`^\\s*${st.uid}\\s.*server-main`, "m"));
  });

  it("deletes a workspace and its folder", async () => {
    const list = (await call("GET", `/api/code/workspaces?workspaceId=${workspaceId}`)).json;
    const second = list.find((w: { slug: string }) => w.slug === "billing-service-2");
    expect((await call("DELETE", `/api/code/workspaces/${second.id}`)).status).toBe(200);
    expect(existsSync(second.path)).toBe(false);
  });
});
