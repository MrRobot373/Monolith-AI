/**
 * Copies uploads from the local storage folder into the S3 bucket, for an install that switches
 * from local disk to S3. Files already in the bucket with the same size are skipped, so it can be
 * run again safely. Nothing is deleted locally.
 *
 *   docker compose exec api node dist/copy-files-to-s3.js      (in the container)
 *   STORAGE_DIR=… S3_BUCKET=… pnpm --filter @aatmiq/api exec tsx src/copy-files-to-s3.ts
 */
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { loadS3 } from "./config";
import { createS3Storage, s3Client, s3Prefix } from "./services/storage";

const cfg = loadS3(process.env);
if (!cfg) {
  console.error("Set S3_BUCKET (and S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY as needed) first.");
  process.exit(2);
}
const root = resolve(process.env.STORAGE_DIR ?? ".data/files");
const storage = createS3Storage(cfg);
await storage.check();
const s3 = s3Client(cfg);
const prefix = s3Prefix(cfg.prefix);

async function* files(dir: string): AsyncGenerator<string> {
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (e.isFile()) yield p;
  }
}

let copied = 0;
let skipped = 0;
let bytes = 0;
for await (const file of files(root)) {
  const key = relative(root, file).split(sep).join("/");
  if (key.startsWith(".aatmiq-check/")) continue;
  const data = await readFile(file);
  const existing = await s3.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: prefix + key })).catch(() => null);
  if (existing?.ContentLength === data.length) {
    skipped++;
    continue;
  }
  await s3.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: prefix + key, Body: data, ContentLength: data.length, ...(cfg.sse ? { ServerSideEncryption: cfg.sse } : {}) }));
  copied++;
  bytes += data.length;
}
console.log(`Copied ${copied} file(s) (${(bytes / 1024 / 1024).toFixed(1)} MB) from ${root} to ${storage.describe()}; ${skipped} ${skipped === 1 ? "was" : "were"} already there.`);
