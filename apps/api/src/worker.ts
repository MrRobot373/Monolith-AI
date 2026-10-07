/**
 * The background worker: runs queued jobs (document processing, housekeeping) from Redis.
 * Same image and settings as the API; start it with `node dist/worker.js` and REDIS_URL set.
 * Run as many as you like; each takes up to JOB_CONCURRENCY documents at once.
 */
import { createDb } from "@aatmiq/db";
import { loadConfig } from "./config";
import { createSecretBox } from "./crypto";
import { runWorker } from "./services/jobs";
import { LicenseService } from "./services/license";
import { stopOcr } from "./services/ocr";
import { createStorage } from "./services/storage";

const cfg = loadConfig();
if (!cfg.redisUrl) {
  console.error("The worker needs REDIS_URL. Without it, the API runs background jobs itself.");
  process.exit(2);
}
const log = (msg: string, err?: unknown) => console.warn(JSON.stringify({ level: 40, time: Date.now(), msg, err: err instanceof Error ? err.message : err }));

const storage = createStorage(cfg);
for (let attempt = 1; ; attempt++) {
  try {
    await storage.check();
    break;
  } catch (e) {
    if (attempt >= 10) throw e;
    log(`${(e as Error).message} Retrying in 3 seconds…`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}
const { db, close } = createDb(cfg.databaseUrl);
const w = await runWorker({ db, box: createSecretBox(cfg.secret), storage, license: new LicenseService(db, cfg), log }, cfg.redisUrl, { concurrency: cfg.jobConcurrency });
console.log(JSON.stringify({ level: 30, time: Date.now(), msg: `Worker ${w.id} running (${cfg.jobConcurrency} at once); files in ${storage.describe()}` }));

const shutdown = async () => {
  await w.close();
  await stopOcr();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
