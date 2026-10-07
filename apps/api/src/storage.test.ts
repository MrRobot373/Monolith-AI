/**
 * The storage contract, on local disk and on every S3-compatible server in S3_TEST_ENDPOINTS:
 *   S3_TEST_ENDPOINTS="minio=http://127.0.0.1:9100|key|secret,seaweed=http://127.0.0.1:8333|key|secret"
 */
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectsCommand, ListObjectsV2Command, type S3Client } from "@aws-sdk/client-s3";
import { createDb, sql, type DB } from "@aatmiq/db";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";
import { createLocalStorage, createS3Storage, s3Client, StorageNotFound, type S3Config, type Storage } from "./services/storage";

const run = promisify(execFile);
const servers = (process.env.S3_TEST_ENDPOINTS ?? "")
  .split(",")
  .filter(Boolean)
  .map((s) => {
    const [name, rest] = s.split("=") as [string, string];
    const [endpoint, accessKeyId, secretAccessKey] = rest.split("|") as [string, string, string];
    return { name, endpoint, accessKeyId, secretAccessKey };
  });

const s3cfg = (srv: (typeof servers)[number], bucket: string, extra: Partial<S3Config> = {}): S3Config => ({
  bucket,
  endpoint: srv.endpoint,
  region: "us-east-1",
  accessKeyId: srv.accessKeyId,
  secretAccessKey: srv.secretAccessKey,
  forcePathStyle: true,
  prefix: "",
  sse: null,
  ...extra,
});

async function emptyAndDelete(client: S3Client, bucket: string) {
  const list = await client.send(new ListObjectsV2Command({ Bucket: bucket })).catch(() => null);
  if (list?.Contents?.length) await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: list.Contents.map((o) => ({ Key: o.Key! })) } }));
  await client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
}

function contract(name: string, make: () => Promise<Storage>) {
  describe(`storage contract: ${name}`, () => {
    let s: Storage;
    beforeAll(async () => {
      s = await make();
    });

    it("writes, reads back exactly, overwrites and deletes", async () => {
      const data = Buffer.from([0, 1, 2, 255, 254, 10, 13]);
      await s.put("ws1/abc", data);
      expect((await s.get("ws1/abc")).equals(data)).toBe(true);
      await s.put("ws1/abc", Buffer.from("second"));
      expect((await s.get("ws1/abc")).toString()).toBe("second");
      await s.remove("ws1/abc");
      await expect(s.get("ws1/abc")).rejects.toBeInstanceOf(StorageNotFound);
    });

    it("a missing file is StorageNotFound (code ENOENT); removing one is fine", async () => {
      const e = await s.get("nope/never").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StorageNotFound);
      expect((e as StorageNotFound).code).toBe("ENOENT");
      await expect(s.remove("nope/never")).resolves.toBeUndefined();
    });

    it("refuses keys that could leave its area", async () => {
      for (const bad of ["../x", "/etc/passwd", "a//b", "a/./b", "a/../../b", ""]) await expect(s.put(bad, Buffer.from("x"))).rejects.toThrow("Invalid storage key");
    });

    it("handles a 6 MB file", async () => {
      const big = Buffer.alloc(6 * 1024 * 1024, 7);
      big[123456] = 1;
      await s.put("big/file", big);
      expect((await s.get("big/file")).equals(big)).toBe(true);
      await s.remove("big/file");
    });

    it("check() passes and leaves nothing behind", async () => {
      await s.check();
      await expect(s.get(".aatmiq-check/anything")).rejects.toBeInstanceOf(StorageNotFound);
    });
  });
}

contract("local disk", async () => createLocalStorage(await mkdtemp(`${tmpdir()}/aatmiq-store-`)));

for (const srv of servers) {
  const bucket = `aatmiq-test-${Date.now().toString(36)}-${srv.name}`;
  const client = s3Client(s3cfg(srv, bucket));
  describe(`S3 on ${srv.name}`, () => {
    beforeAll(async () => {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
    });
    afterAll(async () => {
      await emptyAndDelete(client, bucket);
    });

    contract(`S3 (${srv.name})`, async () => createS3Storage(s3cfg(srv, bucket, { prefix: "aatmiq" })));

    it("keeps files under its prefix", async () => {
      const s = createS3Storage(s3cfg(srv, bucket, { prefix: "/tenant-a/" }));
      await s.put("docs/one", Buffer.from("1"));
      const list = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: "tenant-a/" }));
      expect(list.Contents?.map((o) => o.Key)).toContain("tenant-a/docs/one");
      expect(s.describe()).toBe(`S3 bucket "${bucket}" (folder tenant-a/) at ${srv.endpoint}`);
    });

    it("check() can create a missing bucket when asked", async () => {
      const fresh = `${bucket}-new`;
      await createS3Storage(s3cfg(srv, fresh, { createBucket: true })).check();
      await createS3Storage(s3cfg(srv, fresh)).check();
      await emptyAndDelete(client, fresh);
    });

    it("check() explains a missing bucket and a wrong secret", async () => {
      await expect(createS3Storage(s3cfg(srv, `${bucket}-missing`)).check()).rejects.toThrow("the bucket doesn't exist");
      await expect(createS3Storage(s3cfg(srv, bucket, { secretAccessKey: "wrong-secret" })).check()).rejects.toThrow("access was refused");
    });

    it("the copy script moves an existing install's files into the bucket, once", async () => {
      const dir = await mkdtemp(`${tmpdir()}/aatmiq-copy-`);
      await mkdir(join(dir, "ws9"), { recursive: true });
      await mkdir(join(dir, "branding"), { recursive: true });
      await writeFile(join(dir, "ws9", "doc-a"), "document A");
      await writeFile(join(dir, "branding", "logo-1.png"), Buffer.from([0x89, 0x50]));
      const env = {
        ...process.env,
        STORAGE_DIR: dir,
        S3_BUCKET: bucket,
        S3_ENDPOINT: srv.endpoint,
        S3_ACCESS_KEY_ID: srv.accessKeyId,
        S3_SECRET_ACCESS_KEY: srv.secretAccessKey,
        S3_PREFIX: "moved",
      };
      const first = await run("npx", ["tsx", "src/copy-files-to-s3.ts"], { env, cwd: process.cwd() });
      expect(first.stdout).toContain("Copied 2 file(s)");
      const again = await run("npx", ["tsx", "src/copy-files-to-s3.ts"], { env, cwd: process.cwd() });
      expect(again.stdout).toContain("Copied 0 file(s)");
      expect(again.stdout).toContain("2 were already there");
      const s = createS3Storage(s3cfg(srv, bucket, { prefix: "moved" }));
      expect((await s.get("ws9/doc-a")).toString()).toBe("document A");
    }, 60_000);
  });
}

const url = process.env.TEST_DATABASE_URL;
const first = servers[0];
(url && first ? describe : describe.skip)("the app on S3 storage", () => {
  const APP_URL = "http://localhost:3000";
  const bucket = `aatmiq-app-${Date.now().toString(36)}`;
  const cfgS3 = first ? s3cfg(first, bucket) : null;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let db: DB;
  let close: () => Promise<void>;
  let cookie = "";

  beforeAll(async () => {
    await s3Client(cfgS3!).send(new CreateBucketCommand({ Bucket: bucket }));
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: "test-secret-test-secret-test-secret-1234", allowMockProvider: true, port: 0, storageDir: "/nonexistent", s3: cfgS3 };
    app = await buildApp(db, cfg);
    const setup = await app.inject({ method: "POST", url: "/api/setup", headers: { origin: APP_URL, "content-type": "application/json" }, payload: JSON.stringify({ orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" }) });
    cookie = String(setup.headers["set-cookie"]).split(";")[0]!;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
    await emptyAndDelete(s3Client(cfgS3!), bucket);
  });

  it("an uploaded document lands in the bucket and downloads intact", async () => {
    const me = await app.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    const workspaceId = me.json().workspaces[0].id;
    const boundary = "----aatmiqs3";
    const content = "Quarterly plan\nShip S3 storage.\n";
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspaceId}\r\n` +
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="plan.txt"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${boundary}--\r\n`,
    );
    const up = await app.inject({ method: "POST", url: "/api/documents", headers: { cookie, origin: APP_URL, "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    expect(up.statusCode).toBe(200);
    const id = up.json().id;
    const list = await s3Client(cfgS3!).send(new ListObjectsV2Command({ Bucket: bucket }));
    expect(list.Contents?.some((o) => o.Key!.startsWith(`${workspaceId}/`))).toBe(true);
    const file = await app.inject({ method: "GET", url: `/api/documents/${id}/file`, headers: { cookie } });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe(content);
    // The background step reads it back from the bucket too.
    for (let i = 0; i < 50; i++) {
      const d = await app.inject({ method: "GET", url: `/api/documents/${id}`, headers: { cookie } });
      if (d.json().status !== "processing") {
        expect(d.json().status).toBe("ready");
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  });
});
