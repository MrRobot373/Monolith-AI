/**
 * Admin → Health and the alerts to admins: a model server going down and coming back, backups as
 * deploy/backup/backup.sh records them, disk thresholds, who may look, and the emails (once per
 * problem, a reminder after a day, once when fixed), against a local mail server.
 */
import { createDb, sql, systemStatus, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startSmtpSink } from "../test/smtp-sink.mjs";
import { buildApp } from "./app";
import type { Config } from "./config";
import { diskLevel, writeStatus } from "./services/health";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;
const GB = 1024 ** 3;

describe("disk thresholds", () => {
  it("warns under 10 GB or 15% free, and errs under 2 GB or 5%", () => {
    expect(diskLevel(200 * GB, 500 * GB)).toBe("ok");
    expect(diskLevel(60 * GB, 500 * GB)).toBe("warn");
    expect(diskLevel(9 * GB, 40 * GB)).toBe("warn");
    expect(diskLevel(20 * GB, 500 * GB)).toBe("error");
    expect(diskLevel(1 * GB, 4 * GB)).toBe("error");
  });
});

d("Health and alerts", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let sink: Awaited<ReturnType<typeof startSmtpSink>>;
  let model: Server;
  let modelUp = true;
  let modelUrl = "";
  const owner = { cookie: "" };
  const member = { cookie: "" };

  async function call(j: { cookie: string }, method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(j.cookie ? { cookie: j.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (set) j.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json };
  }
  const health = async () => (await call(owner, "GET", "/api/admin/health")).json as { level: string; checks: { id: string; area: string; level: string; summary: string; hint?: string }[]; settings: { email: boolean; mailConfigured: boolean } };
  const check = async (id: string) => (await health()).checks.find((c) => c.id === id || c.id.startsWith(id));
  const notifications = async () => ((await call(owner, "GET", "/api/notifications")).json as { type: string; title: string; body: string | null }[]).filter((n) => n.type === "health");

  beforeAll(async () => {
    sink = await startSmtpSink();
    model = createServer((req, res) => {
      if (!modelUp) return res.writeHead(503).end("down");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    });
    await new Promise<void>((r) => model.listen(0, "127.0.0.1", r));
    modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;

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
      allowMockProvider: false,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-health-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-health-work-")),
    };
    app = await buildApp(db, cfg);
    await call(owner, "POST", "/api/setup", { orgName: "Acme", name: "Olu Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    const workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    const inv = await call(owner, "POST", "/api/admin/invites", { email: "mia@acme.test", workspaces: [{ workspaceId, role: "member" }] });
    await call(member, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name: "Mia", password: "a-good-password-1" });
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
    await new Promise<void>((r) => model?.close(() => r()));
  });

  it("only admins see it; every area is checked", async () => {
    expect((await call(member, "GET", "/api/admin/health")).status).toBe(403);
    const h = await health();
    expect(new Set(h.checks.map((c) => c.area))).toEqual(new Set(["Database", "Disk", "Models", "Work AI", "Background jobs", "Backups", "Security", "License", "Email"]));
    expect(h.checks.find((c) => c.id === "database")).toMatchObject({ level: "ok" });
    expect(h.checks.find((c) => c.area === "Disk")?.summary).toMatch(/free of .* for uploads, Work AI task folders/);
    expect(h.checks.find((c) => c.id === "work:queue")).toMatchObject({ level: "ok", summary: expect.stringMatching(/^0 of 8 tasks working, 0 waiting for a slot, 0 waiting for someone's approval\.$/) });
    // Nothing set up yet: no model server, no backups, no email.
    expect(h.checks.find((c) => c.id === "models")).toMatchObject({ level: "warn", summary: "No model server is connected." });
    expect(h.checks.find((c) => c.id === "backup")).toMatchObject({ level: "warn", summary: "No backup has been recorded." });
    expect(h.checks.find((c) => c.id === "email")).toMatchObject({ level: "warn" });
    expect((await call(member, "POST", "/api/admin/health/test-alert")).status).toBe(403);
    expect((await call(member, "PUT", "/api/admin/health/settings", { email: false })).status).toBe(403);
  });

  it("backups as the backup service records them: fine, overdue, failed", async () => {
    const now = Date.now();
    await writeStatus(db, "backup", { ok: true, name: "aatmiq-20261009-023000", bytes: 3 * GB, at: new Date(now - 3_600_000).toISOString(), lastOk: new Date(now - 3_600_000).toISOString() });
    expect(await check("backup")).toMatchObject({ level: "ok", summary: "Last backup aatmiq-20261009-023000 1 h ago (3.0 GB)." });
    await writeStatus(db, "backup", { ok: true, name: "aatmiq-20261005-023000", at: new Date(now - 4 * 86_400_000).toISOString() });
    expect(await check("backup")).toMatchObject({ level: "warn", summary: "The last backup is 4 days old." });
    await writeStatus(db, "backup", { ok: false, name: "aatmiq-20261009-023000", bytes: 0, at: new Date(now - 600_000).toISOString(), lastOk: new Date(now - 2 * 86_400_000).toISOString() });
    expect(await check("backup")).toMatchObject({ level: "error", summary: "The last backup failed (10 min ago). The last good one is 2 days old." });
    // backup.sh's own SQL (taken from the script), as its record() runs it: a good run, a failed one.
    const script = await readFile(join(__dirname, "../../../deploy/backup/backup.sh"), "utf8");
    const statement = /psql [^"]*-c "([^"]+)"/.exec(script)![1]!;
    const record = (ok: boolean, name: string, size: number) => db.execute(sql.raw(statement.replaceAll("$1", String(ok)).replaceAll("$2", name).replaceAll("$3", String(size))));
    await db.delete(systemStatus).where(sql`${systemStatus.key} = 'backup'`);
    await record(true, "aatmiq-1", 1024);
    expect(await check("backup")).toMatchObject({ level: "ok", summary: expect.stringContaining("Last backup aatmiq-1") });
    await record(false, "aatmiq-2", 0);
    expect(await check("backup")).toMatchObject({ level: "error", summary: expect.stringMatching(/^The last backup failed \(1 min ago\)\. The last good one is 1 min old\.$/) });
  });

  it("a model server that stops answering alerts admins once, reminds after a day, and says when it's fixed", async () => {
    // Email on, so alerts go out by email too.
    expect((await call(owner, "PUT", "/api/admin/email", { host: "127.0.0.1", port: sink.port, security: "none", from: "Acme AI <ai@acme.test>" })).status).toBe(200);
    const p = await call(owner, "POST", "/api/admin/providers", { name: "GPU server", type: "openai_compatible", baseUrl: modelUrl });
    await call(owner, "POST", "/api/admin/models", { providerId: p.json.id, modelKey: "qwen", displayName: "Qwen", sections: ["chat"] });
    expect(await check("model:")).toMatchObject({ level: "ok", summary: expect.stringMatching(/^GPU server: answering \(\d+ ms\)\.$/) });

    // Fine: nothing to tell (setup-time warnings like "email not set up" never alert).
    const quiet = await app.inject({ method: "GET", url: "/api/health" });
    expect(quiet.statusCode).toBe(200);
    let r = await app.health.tick({ force: true });
    expect(r!.told.filter((t) => t.id.startsWith("model:"))).toEqual([]);

    modelUp = false;
    r = await app.health.tick({ force: true });
    expect(r!.report.level).toBe("error");
    expect(r!.told).toEqual(expect.arrayContaining([{ id: `model:${p.json.id}`, kind: "problem" }]));
    const mail = await sink.next("owner@acme.test", "needs attention");
    expect(mail.text).toContain("GPU server isn't answering");
    expect(mail.text).toContain("http://localhost:3000/admin/health");
    expect((await notifications())[0]).toMatchObject({ title: expect.stringContaining("GPU server isn't answering") });
    // The member hears nothing.
    expect(((await call(member, "GET", "/api/notifications")).json as { type: string }[]).some((n) => n.type === "health")).toBe(false);

    // Still down: no repeat within the day…
    r = await app.health.tick({ force: true });
    expect(r!.told.filter((t) => t.id.startsWith("model:"))).toEqual([]);
    // …and a reminder after it.
    await db.execute(sql`update system_status set value = jsonb_set(value, ${`{model:${p.json.id},notifiedAt}`}::text[], to_jsonb(${Date.now() - 25 * 3_600_000}::bigint)) where key = 'health_alerts'`);
    r = await app.health.tick({ force: true });
    expect(r!.told).toEqual(expect.arrayContaining([{ id: `model:${p.json.id}`, kind: "reminder" }]));
    expect((await sink.next("owner@acme.test", "needs attention")).text).toContain("(still)");

    modelUp = true;
    r = await app.health.tick({ force: true });
    expect(r!.told).toEqual(expect.arrayContaining([{ id: `model:${p.json.id}`, kind: "resolved" }]));
    expect((await sink.next("owner@acme.test", "fixed")).text).toContain("GPU server: answering");
    expect((await notifications())[0]!.title).toMatch(/^Fixed: Models/);
  }, 60_000);

  it("admins can turn the emails off (they still see alerts in Aatmiq), and send a test", async () => {
    expect((await call(owner, "PUT", "/api/admin/health/settings", { email: false })).json).toEqual({ email: false });
    expect((await health()).settings).toMatchObject({ email: false, mailConfigured: true });
    modelUp = false;
    const before = sink.messages.length;
    const r = await app.health.tick({ force: true });
    expect(r!.told.some((t) => t.kind === "problem")).toBe(true);
    await new Promise((res) => setTimeout(res, 300));
    expect(sink.messages.length).toBe(before);
    expect((await notifications())[0]!.title).toContain("isn't answering");
    modelUp = true;
    await app.health.tick({ force: true });

    await call(owner, "PUT", "/api/admin/health/settings", { email: true });
    expect((await call(owner, "POST", "/api/admin/health/test-alert")).json).toEqual({ ok: true, emailed: true });
    expect((await sink.next("owner@acme.test", "needs attention")).text).toContain("This is a test alert");
  }, 60_000);

  it("one API copy runs each round", async () => {
    await db.update(systemStatus).set({ updatedAt: new Date(0) }).where(sql`${systemStatus.key} = 'health_run'`);
    const [a, b] = await Promise.all([app.health.tick(), app.health.tick()]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
    expect(await app.health.tick()).toBeNull();
  }, 60_000);
});
