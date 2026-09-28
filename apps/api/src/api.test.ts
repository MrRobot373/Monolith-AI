/**
 * End-to-end API tests against a real Postgres (TEST_DATABASE_URL, migrated).
 * Covers: setup, invites, roles (D18), chat streaming + metering, quotas (D19), token requests (D13).
 */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";

const cfg: Config = {
  appUrl: APP_URL,
  databaseUrl: url ?? "",
  secret: "test-secret-test-secret-test-secret-1234",
  allowMockProvider: true,
  port: 0,
};

let app: FastifyInstance;
let db: DB;
let close: () => Promise<void>;

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

async function call(
  j: Jar | null,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
) {
  const res = await app.inject({
    method,
    url: path,
    headers: {
      origin: APP_URL,
      ...(j?.cookie ? { cookie: j.cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    payload: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const set = res.headers["set-cookie"];
  if (j && set) {
    const list = Array.isArray(set) ? set : [set];
    const map = new Map(j.cookie.split("; ").filter(Boolean).map((c) => c.split("=") as [string, string]));
    for (const c of list) {
      const [pair] = c.split(";");
      const [k, ...v] = pair!.split("=");
      map.set(k!, v.join("="));
    }
    j.cookie = [...map].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  let json: any = null;
  try {
    json = res.json();
  } catch {
    json = res.body;
  }
  return { status: res.statusCode, json, body: res.body };
}

const d = url ? describe : describe.skip;

d("Aatmiq API", () => {
  const owner = jar();
  const member = jar();
  let workspaceId = "";
  let memberId = "";
  let chatId = "";

  beforeAll(async () => {
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    app = await buildApp(db, cfg);
  });

  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("reports setup required on a fresh install", async () => {
    const r = await call(null, "GET", "/api/public/status");
    expect(r.json.setupRequired).toBe(true);
  });

  it("runs first-time setup and signs the owner in", async () => {
    const r = await call(owner, "POST", "/api/setup", {
      orgName: "Acme Labs",
      name: "Asha Owner",
      email: "owner@acme.test",
      password: "correct-horse-battery",
    });
    expect(r.status).toBe(200);
    const me = await call(owner, "GET", "/api/me");
    expect(me.status).toBe(200);
    expect(me.json.user.orgRole).toBe("owner");
    expect(me.json.workspaces).toHaveLength(1);
    workspaceId = me.json.workspaces[0].id;
  });

  it("refuses a second setup and public sign-up", async () => {
    expect((await call(null, "POST", "/api/setup", {
      orgName: "Evil", name: "x", email: "x@x.test", password: "0123456789ab",
    })).status).toBe(409);
    expect((await call(null, "POST", "/api/auth/sign-up/email", {
      email: "x@x.test", password: "0123456789ab", name: "x",
    })).status).toBe(403);
  });

  it("invites a member who accepts and joins the workspace", async () => {
    const inv = await call(owner, "POST", "/api/admin/invites", {
      email: "Dev@Acme.test",
      workspaces: [{ workspaceId, role: "member" }],
    });
    expect(inv.status).toBe(200);
    const token = inv.json.link.split("/invite/")[1];
    const info = await call(null, "GET", `/api/invites/${token}`);
    expect(info.json.email).toBe("dev@acme.test");

    const acc = await call(member, "POST", `/api/invites/${token}/accept`, { name: "Dev Member", password: "another-good-password" });
    expect(acc.status).toBe(200);
    const me = await call(member, "GET", "/api/me");
    expect(me.json.user.orgRole).toBe("member");
    expect(me.json.workspaces[0].id).toBe(workspaceId);
    memberId = me.json.user.id;

    // Token can't be reused.
    expect((await call(null, "GET", `/api/invites/${token}`)).status).toBe(404);
  });

  it("enforces org roles: members can't use admin endpoints or invite (D18)", async () => {
    expect((await call(member, "GET", "/api/admin/users")).status).toBe(403);
    expect((await call(member, "POST", "/api/admin/invites", { email: "z@acme.test" })).status).toBe(403);
    expect((await call(null, "GET", "/api/me")).status).toBe(401);
  });

  it("streams a chat reply and meters usage", async () => {
    const models = await call(member, "GET", `/api/workspaces/${workspaceId}/models`);
    expect(models.json[0].displayName).toBe("Aatmiq Demo");

    const c = await call(member, "POST", "/api/chats", { workspaceId });
    chatId = c.json.id;
    const r = await call(member, "POST", `/api/chats/${chatId}/messages`, { content: "Hello from the test suite" });
    expect(r.status).toBe(200);
    expect(r.body).toContain("event: delta");
    expect(r.body).toContain("event: done");
    expect(r.body).toContain("Hello from the test suite");

    const full = await call(member, "GET", `/api/chats/${chatId}`);
    expect(full.json.title).toBe("Hello from the test suite");
    expect(full.json.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant"]);

    const q = await call(member, "GET", `/api/workspaces/${workspaceId}/quota`);
    expect(q.json.user.used).toBeGreaterThan(0);
  });

  it("keeps chats private to their owner", async () => {
    expect((await call(owner, "GET", `/api/chats/${chatId}`)).status).toBe(404);
  });

  it("splits the workspace budget evenly and blocks when exhausted (D19)", async () => {
    expect((await call(owner, "PUT", `/api/admin/workspaces/${workspaceId}/budget`, { tokenLimit: 200 })).status).toBe(200);
    const members = await call(owner, "GET", `/api/admin/workspaces/${workspaceId}/members`);
    expect(members.json.every((m: { effectiveLimit: number }) => m.effectiveLimit === 100)).toBe(true);

    // The first chat already used more than 100 tokens, so the next message is blocked.
    const blocked = await call(member, "POST", `/api/chats/${chatId}/messages`, { content: "one more?" });
    expect(blocked.status).toBe(402);
    expect(blocked.json.code).toBe("quota_exceeded");
  });

  it("lets the member request more tokens and the admin approve (D13)", async () => {
    const req = await call(member, "POST", "/api/token-requests", { workspaceId, amount: 100_000, reason: "Quarterly report" });
    expect(req.status).toBe(200);
    expect((await call(member, "POST", "/api/token-requests", { workspaceId, amount: 5 })).status).toBe(409);

    // Member can't approve their own request.
    expect((await call(member, "POST", `/api/token-requests/${req.json.id}/decide`, { decision: "approved" })).status).toBe(403);

    const inbox = await call(owner, "GET", "/api/token-requests?scope=review&status=pending");
    expect(inbox.json).toHaveLength(1);
    const notes = await call(owner, "GET", "/api/notifications");
    expect(notes.json[0].type).toBe("token_request.created");

    const dec = await call(owner, "POST", `/api/token-requests/${req.json.id}/decide`, { decision: "approved" });
    expect(dec.status).toBe(200);

    const ok = await call(member, "POST", `/api/chats/${chatId}/messages`, { content: "back in business" });
    expect(ok.status).toBe(200);
    const memberNotes = await call(member, "GET", "/api/notifications");
    expect(memberNotes.json[0].type).toBe("token_request.approved");
  });

  it("promotes a workspace admin who can manage members but not org settings", async () => {
    await call(owner, "PATCH", `/api/admin/workspaces/${workspaceId}/members/${memberId}`, { role: "admin" });
    expect((await call(member, "GET", `/api/admin/workspaces/${workspaceId}/members`)).status).toBe(200);
    expect((await call(member, "GET", "/api/admin/workspaces")).status).toBe(200);
    expect((await call(member, "GET", "/api/admin/settings")).status).toBe(403);
    expect((await call(member, "PUT", `/api/admin/workspaces/${workspaceId}/budget`, { tokenLimit: null })).status).toBe(403);
  });

  it("reports usage and writes an audit trail", async () => {
    const u = await call(owner, "GET", "/api/admin/usage?days=7");
    expect(u.json.totals.requests).toBeGreaterThanOrEqual(2);
    expect(u.json.daily).toHaveLength(7);
    const a = await call(owner, "GET", "/api/admin/audit");
    const actions = a.json.map((e: { action: string }) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["org.setup", "user.invited", "token_request.approved", "budget.changed"]));
  });

  it("deactivating a user ends their session and blocks sign-in", async () => {
    expect((await call(owner, "PATCH", `/api/admin/users/${memberId}`, { status: "deactivated" })).status).toBe(200);
    expect((await call(member, "GET", "/api/me")).status).toBe(401);
    const again = jar();
    const r = await call(again, "POST", "/api/auth/sign-in/email", { email: "dev@acme.test", password: "another-good-password" });
    expect(r.status).not.toBe(200);
  });

  it("signs the owner in with email and password", async () => {
    const j = jar();
    const r = await call(j, "POST", "/api/auth/sign-in/email", { email: "owner@acme.test", password: "correct-horse-battery" });
    expect(r.status).toBe(200);
    expect((await call(j, "GET", "/api/me")).json.user.email).toBe("owner@acme.test");
  });

  it("encrypts provider API keys at rest", async () => {
    const p = await call(owner, "POST", "/api/admin/providers", {
      name: "Remote vLLM", type: "openai_compatible", baseUrl: "http://127.0.0.1:1/v1", apiKey: "sk-secret-123",
    });
    expect(p.status).toBe(200);
    expect(p.json.health.ok).toBe(false);
    const rows = await db.execute(sql`select api_key_enc from model_provider where name = 'Remote vLLM'`);
    const enc = (rows as unknown as { api_key_enc: string }[])[0]!.api_key_enc;
    expect(enc).not.toContain("sk-secret");
    const list = await call(owner, "GET", "/api/admin/providers");
    expect(JSON.stringify(list.json)).not.toContain("sk-secret");
  });
});
