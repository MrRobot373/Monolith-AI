/**
 * Background jobs: processing uploaded documents (text, OCR, embeddings) and housekeeping
 * (deleting expired temporary chats, the license check-in).
 *
 *  - Without REDIS_URL they run inside the API process: documents a few at a time, housekeeping on
 *    timers. Fine for one server.
 *  - With REDIS_URL the API only queues them (BullMQ) and the worker process (dist/worker.js) runs
 *    them: documents get retries, housekeeping runs once however many API copies there are, and
 *    heavy OCR stays out of the API.
 *
 * Work AI tasks are not jobs: they stream live to the browser from the API that runs them.
 * Either way, documents left "processing" by a restart are queued again at start.
 */
import { document, eq, type DB } from "@aatmiq/db";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { Redis } from "ioredis";
import { hostname } from "node:os";
import type { SecretBox } from "../crypto";
import { purgeTemporaryChats } from "../routes/chat";
import { processDocument } from "./documents";
import type { LicenseService } from "./license";
import type { Storage } from "./storage";

export const QUEUE = "aatmiq-jobs";
const HEARTBEAT_PREFIX = "aatmiq:worker:";
const HEARTBEAT_SECONDS = 10;
const DOC_ATTEMPTS = 4;

export interface JobsStatus {
  mode: "in-process" | "redis";
  /** Workers seen in the last 30 seconds (Redis mode). */
  workers: { id: string; seenAt: string }[];
  counts: { waiting: number; active: number; delayed: number; failed: number };
  /** Something is waiting but no worker is running (Redis mode). */
  stalled: boolean;
}

export interface Jobs {
  readonly mode: "in-process" | "redis";
  /** Queue a stored document for processing (once, however often it's asked). */
  document(id: string): Promise<void>;
  /** Start background work for this process: timers in-process, recurring jobs in Redis. */
  start(): Promise<void>;
  status(): Promise<JobsStatus>;
  close(): Promise<void>;
}

export interface JobDeps {
  db: DB;
  box: SecretBox;
  storage: Storage;
  license: LicenseService;
  log: (msg: string, err?: unknown) => void;
}

/** Documents a restart left half-done. */
async function stuckDocuments(db: DB) {
  return db.select({ id: document.id }).from(document).where(eq(document.status, "processing"));
}

export const redisConnection = (url: string): ConnectionOptions => ({ url, maxRetriesPerRequest: null });

/* ───────────── In-process ───────────── */

export function createInProcessJobs(deps: JobDeps, concurrency = 2): Jobs {
  const queued = new Set<string>();
  const waiting: string[] = [];
  let active = 0;
  let timer: NodeJS.Timeout | undefined;

  const pump = () => {
    while (active < concurrency && waiting.length) {
      const id = waiting.shift()!;
      active++;
      void processDocument(deps.db, deps.box, deps.storage, id)
        .catch((e) => deps.log("processing a document failed", e))
        .finally(() => {
          active--;
          queued.delete(id);
          pump();
        });
    }
  };
  const purge = () => void purgeTemporaryChats(deps.db).catch((e) => deps.log("purging temporary chats failed", e));

  return {
    mode: "in-process",
    async document(id) {
      if (queued.has(id)) return;
      queued.add(id);
      waiting.push(id);
      setImmediate(pump);
    },
    async start() {
      deps.license.start();
      purge();
      timer = setInterval(purge, 60 * 60 * 1000);
      timer.unref();
      for (const d of await stuckDocuments(deps.db)) await this.document(d.id);
    },
    async status() {
      return { mode: "in-process", workers: [], counts: { waiting: waiting.length, active, delayed: 0, failed: 0 }, stalled: false };
    },
    async close() {
      clearInterval(timer);
      deps.license.stop();
    },
  };
}

/* ───────────── Redis (BullMQ): the API's side ───────────── */

export function createRedisJobs(deps: Pick<JobDeps, "db" | "log">, url: string, opts: { retryDelayMs?: number } = {}): Jobs {
  const queue = new Queue(QUEUE, { connection: redisConnection(url) });
  queue.on("error", (e) => deps.log("job queue error", e));
  // Heartbeats are plain keys; reading them needs its own small connection.
  const client = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
  client.on("error", () => undefined);
  return {
    mode: "redis",
    async document(id) {
      await queue.add(
        "document",
        { id },
        {
          // One pending job per document; asking again while it waits or runs does nothing.
          deduplication: { id: `document-${id}` },
          attempts: DOC_ATTEMPTS,
          backoff: { type: "exponential", delay: opts.retryDelayMs ?? 15_000 },
          removeOnComplete: { count: 200 },
          removeOnFail: { count: 500 },
        },
      );
    },
    async start() {
      // Recurring housekeeping: the same scheduler id from every API copy, so it runs once.
      await queue.upsertJobScheduler("purge-temporary-chats", { every: 60 * 60 * 1000 }, { name: "purge-temporary-chats" });
      await queue.upsertJobScheduler("license-check-in", { every: 60 * 60 * 1000 }, { name: "license-check-in" });
      for (const d of await stuckDocuments(deps.db)) await this.document(d.id);
    },
    async status() {
      const keys = await client.keys(`${HEARTBEAT_PREFIX}*`);
      const workers = (await Promise.all(keys.map(async (k) => ({ id: k.slice(HEARTBEAT_PREFIX.length), seenAt: await client.get(k) }))))
        .filter((w): w is { id: string; seenAt: string } => !!w.seenAt)
        .sort((a, b) => a.id.localeCompare(b.id));
      const c = await queue.getJobCounts("waiting", "active", "delayed", "failed", "prioritized");
      const counts = { waiting: (c.waiting ?? 0) + (c.prioritized ?? 0), active: c.active ?? 0, delayed: c.delayed ?? 0, failed: c.failed ?? 0 };
      return { mode: "redis", workers, counts, stalled: workers.length === 0 && counts.waiting + counts.delayed > 0 };
    },
    async close() {
      await queue.close();
      client.disconnect();
    },
  };
}

/* ───────────── Redis (BullMQ): the worker's side ───────────── */

/** Runs queued jobs until stopped. Used by dist/worker.js (and by tests). */
export async function runWorker(deps: JobDeps, url: string, opts: { concurrency?: number } = {}) {
  const id = `${hostname()}-${process.pid}`;
  const worker = new Worker(
    QUEUE,
    async (job) => {
      if (job.name === "document") {
        const willRetry = job.attemptsMade + 1 < (job.opts.attempts ?? 1);
        const r = await processDocument(deps.db, deps.box, deps.storage, (job.data as { id: string }).id, { willRetry });
        // Throwing hands it back to the queue, which tries again later (exponential backoff).
        if (r === "retry") throw new Error("temporary failure, will retry");
        return r;
      }
      if (job.name === "purge-temporary-chats") return purgeTemporaryChats(deps.db);
      if (job.name === "license-check-in") return deps.license.checkInIfDue();
      throw new Error(`Unknown job ${job.name}`);
    },
    { connection: redisConnection(url), concurrency: opts.concurrency ?? 2 },
  );
  worker.on("error", (e) => deps.log("worker error", e));
  worker.on("failed", (job, e) => deps.log(`job ${job?.name} ${job?.id} failed (attempt ${job?.attemptsMade})`, e));
  const client = new Redis(url, { maxRetriesPerRequest: 2 });
  client.on("error", () => undefined);
  const beat = async () => {
    await client.set(`${HEARTBEAT_PREFIX}${id}`, new Date().toISOString(), "EX", HEARTBEAT_SECONDS * 3).catch(() => undefined);
  };
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_SECONDS * 1000);
  return {
    id,
    worker,
    async close() {
      clearInterval(timer);
      await client.del(`${HEARTBEAT_PREFIX}${id}`).catch(() => undefined);
      client.disconnect();
      await worker.close();
    },
  };
}
