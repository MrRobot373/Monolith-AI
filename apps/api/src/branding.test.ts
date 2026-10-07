/** Organization logo: upload checks, the public URL, and the logo in emails. */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSmtpSink } from "../test/smtp-sink.mjs";
import { buildApp } from "./app";
import type { Config } from "./config";
import { sniffLogo, svgProblem } from "./services/branding";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

// 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const SVG = Buffer.from(`<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#22D3EE"/></svg>`);

function multipart(name: string, data: Buffer, type: string) {
  const boundary = "----aatmiq" + Math.random().toString(16).slice(2);
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, type: `multipart/form-data; boundary=${boundary}` };
}

describe("logo checks", () => {
  it("knows images by their bytes, not their names", () => {
    expect(sniffLogo(PNG)).toBe("image/png");
    expect(sniffLogo(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe("image/jpeg");
    expect(sniffLogo(Buffer.from("RIFF\0\0\0\0WEBPVP8 "))).toBe("image/webp");
    expect(sniffLogo(SVG)).toBe("image/svg+xml");
    expect(sniffLogo(Buffer.from("﻿  <!-- made by hand -->\n<svg viewBox='0 0 1 1'></svg>"))).toBe("image/svg+xml");
    expect(sniffLogo(Buffer.from("<html><svg></svg></html>"))).toBeNull();
    expect(sniffLogo(Buffer.from("GIF89a"))).toBeNull();
  });
  it("refuses SVGs that could run code or load other files", () => {
    expect(svgProblem(SVG)).toBeNull();
    expect(svgProblem(Buffer.from(`<svg><script>alert(1)</script></svg>`))).toContain("script");
    expect(svgProblem(Buffer.from(`<svg><rect onload="x()"/></svg>`))).toContain("event handlers");
    expect(svgProblem(Buffer.from(`<svg><a href="javascript:x()"/></svg>`))).toContain("script link");
    expect(svgProblem(Buffer.from(`<svg><foreignObject><p>x</p></foreignObject></svg>`))).toContain("HTML");
    expect(svgProblem(Buffer.from(`<!DOCTYPE svg [<!ENTITY x "y">]><svg/>`))).toContain("entities");
    expect(svgProblem(Buffer.from(`<svg><image href="https://evil.test/x.png"/></svg>`))).toContain("other sites");
    expect(svgProblem(Buffer.from(`<svg><use href="#a"/></svg>`))).toBeNull();
  });
});

d("Organization logo", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  let storageDir = "";
  let cookie = "";
  let memberCookie = "";

  async function call(method: "GET" | "PUT" | "DELETE" | "POST", path: string, opts: { body?: unknown; file?: { name: string; data: Buffer; type: string }; as?: string } = {}) {
    const mp = opts.file ? multipart(opts.file.name, opts.file.data, opts.file.type) : null;
    const res = await app.inject({
      method,
      url: path,
      headers: {
        origin: APP_URL,
        ...(opts.as !== undefined ? (opts.as ? { cookie: opts.as } : {}) : cookie ? { cookie } : {}),
        ...(mp ? { "content-type": mp.type } : opts.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      payload: mp ? mp.body : opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let json = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json, headers: res.headers, raw: res.rawPayload };
  }
  const upload = (name: string, data: Buffer, type = "image/png", as?: string) => call("PUT", "/api/admin/settings/logo", { file: { name, data, type }, as });

  beforeAll(async () => {
    sink = await startSmtpSink();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    storageDir = await mkdtemp(`${tmpdir()}/aatmiq-logo-`);
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: "test-secret-test-secret-test-secret-1234", allowMockProvider: true, port: 0, storageDir };
    app = await buildApp(db, cfg);
    const setup = await call("POST", "/api/setup", { body: { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" }, as: "" });
    cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
    const inv = await call("POST", "/api/admin/invites", { body: { email: "maya@acme.test", orgRole: "member", workspaces: [] } });
    const accepted = await call("POST", `/api/invites/${inv.json.link.split("/").pop()}/accept`, { body: { name: "Maya Patel", password: "first-password-123" }, as: "" });
    memberCookie = String(accepted.headers["set-cookie"]).split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
    await sink?.close();
  });

  it("starts without a logo", async () => {
    expect((await call("GET", "/api/public/status", { as: "" })).json.org.logoUrl).toBeNull();
    expect((await call("GET", "/api/public/logo", { as: "" })).status).toBe(404);
  });

  it("only branding admins can upload, and only real, small, safe images", async () => {
    expect((await upload("logo.png", PNG, "image/png", memberCookie)).status).toBe(403);
    expect((await upload("logo.png", PNG, "image/png", "")).status).toBe(401);
    // A renamed text file is refused whatever its name and type say.
    const fake = await upload("logo.png", Buffer.from("not an image at all"), "image/png");
    expect(fake.status).toBe(415);
    expect(fake.json.error).toContain("PNG, JPEG, WebP or SVG");
    const big = await upload("big.png", Buffer.concat([PNG, Buffer.alloc(600 * 1024)]));
    expect(big.status).toBe(400);
    expect(big.json.error).toContain("512 KB");
    const evil = await upload("x.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "image/svg+xml");
    expect(evil.status).toBe(400);
    expect(evil.json.error).toContain("script");
    expect((await call("PUT", "/api/admin/settings/logo", { body: {} })).status).toBe(400);
  });

  it("an uploaded logo is public, cached by version, and can't run anything", async () => {
    const r = await upload("acme.png", PNG);
    expect(r.status).toBe(200);
    const logoUrl: string = r.json.logoUrl;
    expect(logoUrl).toMatch(/^\/api\/public\/logo\?v=[0-9a-f]{12}$/);
    expect((await call("GET", "/api/public/status", { as: "" })).json.org.logoUrl).toBe(logoUrl);
    expect((await call("GET", "/api/me")).json.org.logoUrl).toBe(logoUrl);
    expect((await call("GET", "/api/admin/settings")).json.logoUrl).toBe(logoUrl);

    const img = await call("GET", logoUrl, { as: "" });
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toBe("image/png");
    expect(img.raw.equals(PNG)).toBe(true);
    expect(img.headers["cache-control"]).toContain("immutable");
    expect(img.headers["content-security-policy"]).toContain("sandbox");
    expect(img.headers["x-content-type-options"]).toBe("nosniff");
    // An old version URL is only cached briefly.
    expect((await call("GET", "/api/public/logo?v=old", { as: "" })).headers["cache-control"]).toBe("public, max-age=300");

    // Replacing it removes the old file and changes the URL.
    const svg = await upload("acme.svg", SVG, "image/svg+xml");
    expect(svg.json.logoUrl).not.toBe(logoUrl);
    const served = await call("GET", svg.json.logoUrl, { as: "" });
    expect(served.headers["content-type"]).toBe("image/svg+xml");
    expect((await readdir(`${storageDir}/branding`)).length).toBe(1);
  });

  it("emails carry a PNG or JPEG logo inline (SVG isn't shown by most mail clients)", async () => {
    await call("PUT", "/api/admin/email", { body: { host: "127.0.0.1", port: sink.port, security: "none", from: "Acme AI <ai@acme.test>" } });
    await call("POST", "/api/admin/email/test");
    const withSvg = await sink.next("owner@acme.test", "test email");
    expect(withSvg.text).not.toContain("cid:org-logo");

    await upload("acme.png", PNG);
    await call("POST", "/api/admin/email/test");
    const withPng = await sink.next("owner@acme.test", "test email");
    expect(withPng.text).toContain('src="cid:org-logo@aatmiq"');
    expect(withPng.text).toContain("Content-ID: <org-logo@aatmiq>");
  });

  it("removing the logo goes back to the product mark", async () => {
    expect((await call("DELETE", "/api/admin/settings/logo", { as: memberCookie })).status).toBe(403);
    expect((await call("DELETE", "/api/admin/settings/logo")).json).toEqual({ logoUrl: null });
    expect((await call("GET", "/api/public/status", { as: "" })).json.org.logoUrl).toBeNull();
    expect((await call("GET", "/api/public/logo", { as: "" })).status).toBe(404);
    expect(await readdir(`${storageDir}/branding`)).toEqual([]);
    const actions = (await db.execute(sql`select action from audit_log`)) as unknown as { action: string }[];
    expect(actions.map((a) => a.action)).toEqual(expect.arrayContaining(["settings.logo_updated", "settings.logo_removed"]));
  });
});
