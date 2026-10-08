/**
 * First setup with the bundled model server (deploy/docker-compose.gpu.yml): the model is
 * registered, enabled everywhere and the default, and the organization's task limit is set.
 */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import { loadConfig, loadSetupModel, type Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";

describe("SETUP_MODEL_* settings", () => {
  it("reads the model server and refuses incomplete settings", () => {
    expect(loadSetupModel({})).toBeNull();
    expect(loadSetupModel({ SETUP_MODEL_URL: "http://vllm:8000/v1/", SETUP_MODEL: "qwen3.6-35b-a3b", SETUP_MODEL_CONTEXT: "65536", SETUP_MODEL_VISION: "true" })).toEqual({
      url: "http://vllm:8000/v1",
      key: "qwen3.6-35b-a3b",
      displayName: "qwen3.6-35b-a3b",
      contextLength: 65536,
      apiKey: null,
      vision: true,
      sections: ["chat", "work", "code"],
    });
    expect(() => loadSetupModel({ SETUP_MODEL_URL: "http://vllm:8000/v1" })).toThrow("SETUP_MODEL");
    expect(() => loadSetupModel({ SETUP_MODEL_URL: "vllm:8000", SETUP_MODEL: "x" })).toThrow("http");
    expect(() => loadSetupModel({ SETUP_MODEL_URL: "http://x", SETUP_MODEL: "x", SETUP_MODEL_SECTIONS: "chat,email" })).toThrow("SECTIONS");
    const base = { APP_SECRET: "x".repeat(32), DATABASE_URL: "postgres://x" };
    expect(loadConfig({ ...base, SETUP_MAX_RUNNING: "10" }).setupMaxRunning).toBe(10);
    expect(loadConfig(base).setupMaxRunning).toBeNull();
    // The small model is Chat-only unless told otherwise.
    const both = loadConfig({ ...base, SETUP_MODEL_URL: "http://a/v1", SETUP_MODEL: "big", SETUP_SMALL_MODEL_URL: "http://b/v1", SETUP_SMALL_MODEL: "small" }).setupModels!;
    expect(both.map((m) => [m.key, m.sections])).toEqual([["big", ["chat", "work", "code"]], ["small", ["chat"]]]);
  });
});

(url ? describe : describe.skip)("first setup with a model server", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  let cookie = "";
  const call = async (method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await app.inject({ method, url: path, headers: { origin: APP_URL, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, payload: body ? JSON.stringify(body) : undefined });
    const set = res.headers["set-cookie"];
    if (set) cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    return { status: res.statusCode, json: res.json() as any };
  };

  beforeAll(async () => {
    ({ db, close } = createDb(url!));
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
      allowMockProvider: false,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-work-")),
      setupModels: [
        { url: "http://vllm:8000/v1", key: "qwen3.6-35b-a3b", displayName: "Qwen3.6 35B A3B", contextLength: 65536, apiKey: "local-key", vision: true, sections: ["chat", "work", "code"] },
        { url: "http://vllm-small:8000/v1", key: "gemma-4-e2b", displayName: "Gemma 4 E2B (fast)", contextLength: 32768, apiKey: null, vision: false, sections: ["chat"] },
      ],
      setupMaxRunning: 10,
    };
    app = await buildApp(db, cfg);
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("registers the main model everywhere as the default, the small one for Chat, and the task limit", async () => {
    expect((await call("POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    const models = (await call("GET", "/api/admin/models")).json;
    expect(models).toHaveLength(2);
    expect(models.find((m: { modelKey: string }) => m.modelKey === "qwen3.6-35b-a3b")).toMatchObject({ contextLength: 65536, vision: true, sections: ["chat", "work", "code"], enabled: true });
    expect(models.find((m: { modelKey: string }) => m.modelKey === "gemma-4-e2b")).toMatchObject({ sections: ["chat"], vision: false });
    const providers = (await call("GET", "/api/admin/providers")).json;
    expect(providers.map((p: { baseUrl: string; hasApiKey: boolean }) => [p.baseUrl, p.hasApiKey]).sort()).toEqual([["http://vllm-small:8000/v1", false], ["http://vllm:8000/v1", true]]);
    const ws = (await call("GET", "/api/me")).json.workspaces[0].id;
    const names = async (section: string) =>
      ((await call("GET", `/api/workspaces/${ws}/models?section=${section}`)).json as { displayName: string; isDefault: boolean }[]).map((m) => [m.displayName, m.isDefault]).sort();
    expect(await names("chat")).toEqual([["Gemma 4 E2B (fast)", false], ["Qwen3.6 35B A3B", true]]);
    expect(await names("work")).toEqual([["Qwen3.6 35B A3B", true]]);
    expect(await names("code")).toEqual([["Qwen3.6 35B A3B", true]]);
    expect((await call("GET", "/api/admin/work")).json.settings).toMatchObject({ maxRunning: 10, maxConcurrentPerUser: 2 });
  });
});
