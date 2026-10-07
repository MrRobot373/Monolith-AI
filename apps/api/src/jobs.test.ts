/**
 * Background jobs, in the API (no Redis) and through the queue with a separate worker.
 * The queue tests need REDIS_TEST_URL (Redis or Valkey), e.g. redis://127.0.0.1:6379/5.
 */
import { createDb, document, eq, sql, type DB } from "@aatmiq/db";
import { Queue } from "bullmq";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { createSecretBox } from "./crypto";
import { createRedisJobs, QUEUE, redisConnection, runWorker } from "./services/jobs";
import { LicenseService } from "./services/license";
import { createLocalStorage, type Storage } from "./services/storage";

const url = process.env.TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_TEST_URL;
const APP_URL = "http://localhost:3000";
const SECRET = "test-secret-test-secret-test-secret-1234";

function multipart(fields: Record<string, string>, file: { name: string; content: string }) {
  const b = `----aatmiq${Math.random().toString(16).slice(2)}`;
  const parts = Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
  parts.push(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/plain\r\n\r\n${file.content}\r\n--${b}--\r\n`);
  return { body: Buffer.from(parts.join("")), type: `multipart/form-data; boundary=${b}` };
}

async function fresh(db: DB) {
  await db.execute(sql`
    do $$ declare r record; begin
      for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
        execute 'truncate table "' || r.tablename || '" cascade';
      end loop;
    end $$;`);
}

async function setup(app: FastifyInstance) {
  const r = await app.inject({ method: "POST", url: "/api/setup", headers: { origin: APP_URL, "content-type": "application/json" }, payload: JSON.stringify({ orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" }) });
  const cookie = String(r.headers["set-cookie"]).split(";")[0]!;
  const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
  return { cookie, workspaceId: me.json().workspaces[0].id as string };
}

async function upload(app: FastifyInstance, s: { cookie: string; workspaceId: string }, name: string, content: string) {
  const mp = multipart({ workspaceId: s.workspaceId }, { name, content });
  const r = await app.inject({ method: "POST", url: "/api/documents", headers: { cookie: s.cookie, origin: APP_URL, "content-type": mp.type }, payload: mp.body });
  expect(r.statusCode).toBe(200);
  return r.json().id as string;
}

async function statusOf(db: DB, id: string) {
  return (await db.select({ status: document.status, error: document.error }).from(document).where(eq(document.id, id)))[0]!;
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 15_000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out; last value ${JSON.stringify(v)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

(url ? describe : describe.skip)("jobs inside the API (no Redis)", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let storageDir = "";

  beforeAll(async () => {
    ({ db, close } = createDb(url));
    await fresh(db);
    storageDir = await mkdtemp(`${tmpdir()}/aatmiq-jobs-`);
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("processes uploads, and picks up documents a restart left half-done", async () => {
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: SECRET, allowMockProvider: true, port: 0, storageDir };
    app = await buildApp(db, cfg);
    await app.ready();
    const s = await setup(app);
    const id = await upload(app, s, "plan.txt", "Quarterly plan: ship background jobs.");
    expect((await until(() => statusOf(db, id), (d) => d.status !== "processing")).status).toBe("ready");

    // Pretend the server died mid-processing, then start a new API.
    await db.update(document).set({ status: "processing", chunkCount: 0 }).where(eq(document.id, id));
    await app.close();
    app = await buildApp(db, cfg);
    await app.ready();
    expect((await until(() => statusOf(db, id), (d) => d.status !== "processing")).status).toBe("ready");
    const jobs = await app.inject({ method: "GET", url: "/api/admin/jobs", headers: { cookie: s.cookie } });
    expect(jobs.json()).toMatchObject({ mode: "in-process", workers: [], stalled: false, documentsProcessing: 0 });
  });
});

(url && redisUrl ? describe : describe.skip)("jobs through the queue and a worker", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let storage: Storage;
  let s: { cookie: string; workspaceId: string };
  const workers: { close: () => Promise<void> }[] = [];
  const quiet = () => undefined;

  const startWorker = async (st: Storage = storage) => {
    const w = await runWorker({ db, box: createSecretBox(SECRET), storage: st, license: new LicenseService(db, { appUrl: APP_URL, databaseUrl: url!, secret: SECRET, allowMockProvider: true, port: 0, storageDir: "" }), log: quiet }, redisUrl!, { concurrency: 2 });
    workers.push(w);
    return w;
  };
  const jobsStatus = async () => (await app.inject({ method: "GET", url: "/api/admin/jobs", headers: { cookie: s.cookie } })).json();

  beforeAll(async () => {
    ({ db, close } = createDb(url));
    await fresh(db);
    const q = new Queue(QUEUE, { connection: redisConnection(redisUrl!) });
    await q.obliterate({ force: true });
    await q.close();
    storage = createLocalStorage(await mkdtemp(`${tmpdir()}/aatmiq-jobs-`));
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: SECRET, allowMockProvider: true, port: 0, storageDir: "", redisUrl };
    app = await buildApp(db, cfg, { storage, jobs: (ctx) => createRedisJobs({ db: ctx.db, log: quiet }, redisUrl!, { retryDelayMs: 100 }) });
    await app.ready();
    s = await setup(app);
  });
  afterAll(async () => {
    for (const w of workers) await w.close().catch(() => undefined);
    await app?.close();
    await close?.();
  });

  it("the API only queues: without a worker the document waits and the admin is told", async () => {
    const id = await upload(app, s, "notes.txt", "Meeting notes: the worker processes this.");
    await new Promise((r) => setTimeout(r, 500));
    expect((await statusOf(db, id)).status).toBe("processing");
    const st = await jobsStatus();
    expect(st).toMatchObject({ mode: "redis", workers: [], stalled: true, documentsProcessing: 1 });
    // The document plus the two housekeeping jobs wait for a worker.
    expect(st.counts.waiting).toBe(3);
    // Asking again doesn't queue the document twice.
    const again = await app.inject({ method: "POST", url: `/api/documents/${id}/reprocess`, headers: { cookie: s.cookie, origin: APP_URL } });
    expect(again.statusCode).toBe(200);
    expect((await jobsStatus()).counts.waiting).toBe(3);
  });

  it("a worker picks it up, reports a heartbeat, and the housekeeping jobs are scheduled once", async () => {
    const w = await startWorker();
    const id = (await db.select({ id: document.id }).from(document))[0]!.id;
    expect((await until(() => statusOf(db, id), (d) => d.status !== "processing")).status).toBe("ready");
    const st = await jobsStatus();
    expect(st.stalled).toBe(false);
    expect(st.workers.map((x: { id: string }) => x.id)).toContain((w as { id: string }).id);
    const q = new Queue(QUEUE, { connection: redisConnection(redisUrl!) });
    expect((await q.getJobSchedulers()).map((j) => j.key).sort()).toEqual(["license-check-in", "purge-temporary-chats"]);
    await q.close();
  });

  it("a temporary failure (storage down) is retried; a file with no text fails once, for good", async () => {
    for (const w of workers.splice(0)) await w.close();
    let failures = 2;
    const flaky: Storage = {
      ...storage,
      async get(key) {
        if (failures-- > 0) throw new Error("storage is down");
        return storage.get(key);
      },
    };
    await startWorker(flaky);
    const id = await upload(app, s, "retry.txt", "This one needs a second try.");
    const done = await until(() => statusOf(db, id), (d) => d.status !== "processing");
    expect(done.status).toBe("ready");
    expect(failures).toBeLessThan(0);

    const empty = await upload(app, s, "empty.txt", "   ");
    const failed = await until(() => statusOf(db, empty), (d) => d.status !== "processing");
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("No readable text");
  });

  it("a stopped worker disappears from the status", async () => {
    for (const w of workers.splice(0)) await w.close();
    expect((await jobsStatus()).workers).toEqual([]);
  });
});
