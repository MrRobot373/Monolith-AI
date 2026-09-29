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
  storageDir: "",
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
    expect(members.json.map((m: { effectiveLimit: number }) => m.effectiveLimit)).toEqual([100, 100]);

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

  it("a permanent approval unblocks the member even when the workspace budget is used up", async () => {
    // Give the member a large personal allowance so the workspace is the tighter limit.
    await call(owner, "PATCH", `/api/admin/workspaces/${workspaceId}/members/${memberId}`, { tokenLimit: 100_000_000 });
    const q = await call(member, "GET", `/api/workspaces/${workspaceId}/quota`);
    const wsRemaining = q.json.workspace.limit + q.json.workspace.bonus - q.json.workspace.used;
    // Use up the whole workspace allowance, including the earlier bonus.
    await db.execute(sql`insert into usage_event (workspace_id, user_id, section, input_tokens, output_tokens)
      values (${workspaceId}, ${memberId}, 'chat', ${wsRemaining + 10}, 0)`);
    const blocked = await call(member, "POST", `/api/chats/${chatId}/messages`, { content: "blocked?" });
    expect(blocked.json.details.result.blockedBy).toBe("workspace");
    const r = await call(member, "POST", "/api/token-requests", { workspaceId, amount: 500_000, duration: "permanent" });
    await call(owner, "POST", `/api/token-requests/${r.json.id}/decide`, { decision: "approved" });
    expect((await call(member, "POST", `/api/chats/${chatId}/messages`, { content: "unblocked" })).status).toBe(200);
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
    // Correlated per-row totals (regression: must not be 0 when usage exists).
    const ws = await call(owner, "GET", "/api/admin/workspaces");
    expect(ws.json[0].used).toBeGreaterThan(0);
    const users = await call(owner, "GET", "/api/admin/users");
    expect(users.json.find((x: { id: string }) => x.id === memberId).tokensThisPeriod).toBeGreaterThan(0);
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

  it("locks an account after 10 failed sign-ins without blocking other accounts", async () => {
    const j = jar();
    // More than Better Auth's default of 3 per 10s per IP must be allowed (shared office IPs).
    for (let i = 0; i < 10; i++) {
      expect((await call(j, "POST", "/api/auth/sign-in/email", { email: "someone@acme.test", password: `wrong-password-${i}` })).status).toBe(401);
    }
    const locked = await call(j, "POST", "/api/auth/sign-in/email", { email: "someone@acme.test", password: "whatever-password" });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("too_many_attempts");
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

/* ───────────── Documents ───────────── */

function multipart(fields: Record<string, string>, file: { name: string; content: Buffer | string; type?: string }) {
  const boundary = `----aatmiq${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields))
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type ?? "text/plain"}\r\n\r\n`,
    ),
  );
  parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

d("Documents", () => {
  const owner = jar();
  const member = jar();
  let workspaceId = "";
  let storageDir = "";
  let policyId = "";
  let handbookId = "";

  async function upload(j: Jar, name: string, content: string, scope = "private") {
    const { body, contentType } = multipart({ workspaceId, scope }, { name, content });
    const res = await app.inject({
      method: "POST",
      url: "/api/documents",
      headers: { origin: APP_URL, cookie: j.cookie, "content-type": contentType },
      payload: body,
    });
    return { status: res.statusCode, json: res.json() };
  }
  async function waitReady(j: Jar, id: string) {
    for (let i = 0; i < 50; i++) {
      const r = await call(j, "GET", `/api/documents/${id}`);
      if (r.json.status !== "processing") return r.json;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("document stayed in processing");
  }

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    storageDir = await mkdtemp(`${tmpdir()}/aatmiq-docs-`);
    await app?.close();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    app = await buildApp(db, { ...cfg, storageDir });
    await call(owner, "POST", "/api/setup", { orgName: "Docs Co", name: "Owner", email: "o@docs.test", password: "correct-horse-battery" });
    workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    const inv = await call(owner, "POST", "/api/admin/invites", { email: "m@docs.test", workspaces: [{ workspaceId, role: "member" }] });
    await call(member, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name: "Member", password: "another-good-password" });
  });

  it("rejects unsupported file types", async () => {
    const r = await upload(owner, "movie.mp4", "not really a video");
    expect(r.status).toBe(415);
  });

  it("uploads, processes and embeds a document", async () => {
    const r = await upload(owner, "leave-policy.md", "# Leave policy\n\nEmployees get 24 days of annual leave per year.\n\nSick leave is 10 days.");
    expect(r.status).toBe(200);
    policyId = r.json.id;
    const doc = await waitReady(owner, policyId);
    expect(doc.status).toBe("ready");
    expect(doc.chunkCount).toBeGreaterThan(0);
    expect(doc.embeddingModelId).toBeTruthy();
  });

  it("keeps private documents private until shared", async () => {
    expect((await call(member, "GET", `/api/documents?workspaceId=${workspaceId}`)).json).toHaveLength(0);
    expect((await call(member, "GET", `/api/documents/${policyId}`)).status).toBe(404);
    expect((await call(member, "PATCH", `/api/documents/${policyId}`, { scope: "workspace" })).status).toBe(404);
    expect((await call(owner, "PATCH", `/api/documents/${policyId}`, { scope: "workspace" })).status).toBe(200);
    expect((await call(member, "GET", `/api/documents?workspaceId=${workspaceId}`)).json).toHaveLength(1);
    // Shared, but only the owner or a workspace admin can change or delete it.
    expect((await call(member, "DELETE", `/api/documents/${policyId}`)).status).toBe(403);
  });

  it("answers with numbered citations from attached documents", async () => {
    const c = await call(member, "POST", "/api/chats", { workspaceId });
    const r = await call(member, "POST", `/api/chats/${c.json.id}/messages`, { content: "How many days of annual leave?", documentIds: [policyId] });
    expect(r.status).toBe(200);
    const start = JSON.parse(r.body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
    expect(start.citations[0]).toMatchObject({ n: 1, documentId: policyId, name: "leave-policy.md" });
    expect(r.body).toContain("[1]");
    const full = await call(member, "GET", `/api/chats/${c.json.id}`);
    expect(full.json.documents.map((x: { id: string }) => x.id)).toEqual([policyId]);
    expect(full.json.messages[0].attachments[0].name).toBe("leave-policy.md");
    expect(full.json.messages[1].citations[0].snippet).toContain("24 days");
  });

  it("can't attach someone else's private document", async () => {
    const r = await upload(owner, "secret.txt", "Board salary numbers");
    await waitReady(owner, r.json.id);
    const c = await call(member, "POST", "/api/chats", { workspaceId });
    const res = await call(member, "POST", `/api/chats/${c.json.id}/messages`, { content: "hi", documentIds: [r.json.id] });
    expect(res.status).toBe(400);
  });

  it("finds the right passage in a long document", async () => {
    const filler = Array.from({ length: 60 }, (_, i) => `Section ${i}. ${"General company information and routine procedures. ".repeat(8)}`);
    filler.splice(41, 0, "Facilities. The office parking code for the basement garage is 4471, changed every quarter.");
    const r = await upload(owner, "handbook.txt", filler.join("\n\n"));
    handbookId = r.json.id;
    const doc = await waitReady(owner, handbookId);
    expect(doc.chunkCount).toBeGreaterThan(10);
    const c = await call(owner, "POST", "/api/chats", { workspaceId });
    const res = await call(owner, "POST", `/api/chats/${c.json.id}/messages`, { content: "What is the parking garage code?", documentIds: [handbookId] });
    const start = JSON.parse(res.body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
    expect(start.citations.length).toBeLessThanOrEqual(6);
    expect(start.citations[0].snippet).toContain("4471");
  });

  it("deletes a document and its file", async () => {
    const { readdir } = await import("node:fs/promises");
    const before = (await readdir(`${storageDir}/${workspaceId}`)).length;
    expect((await call(owner, "DELETE", `/api/documents/${handbookId}`)).status).toBe(200);
    expect((await call(owner, "GET", `/api/documents/${handbookId}`)).status).toBe(404);
    expect((await readdir(`${storageDir}/${workspaceId}`)).length).toBe(before - 1);
  });
});

/* ───────────── Projects ───────────── */

d("Projects", () => {
  const owner = jar();
  const member = jar();
  const other = jar();
  let workspaceId = "";
  let otherId = "";
  let projectId = "";
  let firstChat = "";
  let libraryDoc = "";

  const startOf = (body: string) => JSON.parse(body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
  async function waitSources(j: Jar) {
    for (let i = 0; i < 50; i++) {
      const p = await call(j, "GET", `/api/projects/${projectId}`);
      if (p.json.sources.every((s: { status: string }) => s.status !== "processing")) return p.json;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("sources stayed in processing");
  }

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const storageDir = await mkdtemp(`${tmpdir()}/aatmiq-proj-`);
    await app?.close();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    app = await buildApp(db, { ...cfg, storageDir });
    await call(owner, "POST", "/api/setup", { orgName: "Proj Co", name: "Owner", email: "o@proj.test", password: "correct-horse-battery" });
    workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    for (const [j, email, name] of [[member, "m@proj.test", "Mira"], [other, "x@proj.test", "Xavi"]] as const) {
      const inv = await call(owner, "POST", "/api/admin/invites", { email, workspaces: [{ workspaceId, role: "member" }] });
      await call(j, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name, password: "another-good-password" });
    }
    otherId = (await call(other, "GET", "/api/me")).json.user.id;
  });

  it("creates a private project only its owner (and admins) can see", async () => {
    const r = await call(member, "POST", "/api/projects", {
      workspaceId,
      name: "Office move",
      instructions: "Always answer as a bulleted checklist.",
    });
    expect(r.status).toBe(200);
    projectId = r.json.id;
    expect((await call(member, "GET", `/api/projects?workspaceId=${workspaceId}`)).json).toHaveLength(1);
    expect((await call(other, "GET", `/api/projects?workspaceId=${workspaceId}`)).json).toHaveLength(0);
    expect((await call(other, "GET", `/api/projects/${projectId}`)).status).toBe(404);
    // Org admins can manage every project.
    expect((await call(owner, "GET", `/api/projects/${projectId}`)).json.canEdit).toBe(true);
  });

  it("answers from project sources and follows project instructions", async () => {
    const note = await call(member, "POST", `/api/projects/${projectId}/sources/note`, {
      title: "Move plan",
      content: "The office moves to Riverside Tower on 14 March. Movers arrive at 7am.",
    });
    expect(note.status).toBe(200);
    const p = await waitSources(member);
    expect(p.sources[0]).toMatchObject({ name: "Move plan.md", kind: "note", status: "ready" });

    await call(member, "PATCH", "/api/me", { customInstructions: "Answer in French." });
    const c = await call(member, "POST", "/api/chats", { workspaceId, projectId });
    firstChat = c.json.id;
    const r = await call(member, "POST", `/api/chats/${firstChat}/messages`, { content: "When is the move to Riverside Tower?" });
    expect(r.status).toBe(200);
    expect(startOf(r.body).citations[0]).toMatchObject({ kind: "document", name: "Move plan.md" });
    const full = await call(member, "GET", `/api/chats/${firstChat}`);
    expect(full.json.messages[1].content).toContain("following its instructions");
    expect(full.json.project).toMatchObject({ id: projectId, name: "Office move" });

    // Project chats live in the project, not in Recents.
    expect((await call(member, "GET", `/api/chats?workspaceId=${workspaceId}`)).json).toHaveLength(0);
    expect((await call(member, "GET", `/api/chats?workspaceId=${workspaceId}&projectId=${projectId}`)).json).toHaveLength(1);
  });

  it("remembers earlier chats in the same project", async () => {
    const c = await call(member, "POST", "/api/chats", { workspaceId, projectId });
    await call(member, "POST", `/api/chats/${c.json.id}/messages`, { content: "Budget note: the catering budget is 3200 euros" });
    const c2 = await call(member, "POST", "/api/chats", { workspaceId, projectId });
    const r = await call(member, "POST", `/api/chats/${c2.json.id}/messages`, { content: "What was the catering budget?" });
    const chatCites = startOf(r.body).citations.filter((x: { kind: string }) => x.kind === "chat");
    expect(chatCites[0]).toMatchObject({ chatId: c.json.id });
    expect(chatCites[0].snippet).toContain("3200");
  });

  it("shares with a member: sources and instructions yes, private chats no", async () => {
    expect((await call(member, "PUT", `/api/projects/${projectId}/members`, { userId: otherId, role: "chat" })).status).toBe(200);
    const p = await call(other, "GET", `/api/projects/${projectId}`);
    expect(p.status).toBe(200);
    expect(p.json.role).toBe("chat");
    expect(p.json.instructions).toContain("checklist");
    expect(p.json.chats).toHaveLength(0);
    expect((await call(other, "GET", `/api/chats/${firstChat}`)).status).toBe(404);
    expect((await call(other, "GET", `/api/documents/${p.json.sources[0].id}`)).status).toBe(200);
    // "chat" role can't change the project.
    expect((await call(other, "PATCH", `/api/projects/${projectId}`, { instructions: "x" })).status).toBe(403);
    expect((await call(other, "POST", `/api/projects/${projectId}/sources/note`, { title: "x", content: "y" })).status).toBe(403);

    // The other member's own project chat isn't recalled in Mira's chats.
    const oc = await call(other, "POST", "/api/chats", { workspaceId, projectId });
    await call(other, "POST", `/api/chats/${oc.json.id}/messages`, { content: "My secret salary is 9999 zorkmids" });
    const mc = await call(member, "POST", "/api/chats", { workspaceId, projectId });
    const r = await call(member, "POST", `/api/chats/${mc.json.id}/messages`, { content: "zorkmids salary?" });
    expect(r.body).not.toContain("9999");
  });

  it("shares a chat to the project read-only", async () => {
    expect((await call(member, "PATCH", `/api/chats/${firstChat}`, { sharedToProject: true })).status).toBe(200);
    const p = await call(other, "GET", `/api/projects/${projectId}`);
    // Xavi sees the shared chat plus his own, never Mira's unshared ones.
    expect(p.json.chats.map((c: { userName: string }) => c.userName).sort()).toEqual(["Mira", "Xavi"]);
    expect(p.json.chats.map((c: { id: string }) => c.id)).toContain(firstChat);
    const c = await call(other, "GET", `/api/chats/${firstChat}`);
    expect(c.json).toMatchObject({ readOnly: true, authorName: "Mira" });
    expect((await call(other, "POST", `/api/chats/${firstChat}/messages`, { content: "hi" })).status).toBe(404);
    expect((await call(other, "PATCH", `/api/chats/${firstChat}`, { title: "mine now" })).status).toBe(404);
  });

  it("gives linked library documents to project members", async () => {
    const { body, contentType } = multipart({ workspaceId, scope: "private" }, { name: "floorplan.txt", content: "Desks are on floor 12." });
    const up = await app.inject({ method: "POST", url: "/api/documents", headers: { origin: APP_URL, cookie: member.cookie, "content-type": contentType }, payload: body });
    libraryDoc = up.json().id;
    expect((await call(other, "GET", `/api/documents/${libraryDoc}`)).status).toBe(404);
    expect((await call(member, "POST", `/api/projects/${projectId}/sources/link`, { documentId: libraryDoc })).status).toBe(200);
    expect((await call(other, "GET", `/api/documents/${libraryDoc}`)).status).toBe(200);
    // Linked documents stay in the owner's library.
    expect((await call(member, "GET", `/api/documents?workspaceId=${workspaceId}`)).json.map((x: { id: string }) => x.id)).toEqual([libraryDoc]);
  });

  it("moves, archives and searches chats", async () => {
    const found = await call(member, "GET", `/api/search?workspaceId=${workspaceId}&q=catering`);
    expect(found.json.chats[0]).toMatchObject({ projectName: "Office move" });
    // Matches inside message text come back with a snippet.
    const inText = await call(member, "GET", `/api/search?workspaceId=${workspaceId}&q=movers`);
    expect(inText.json.chats.find((c: { snippet: string | null }) => c.snippet)?.snippet).toMatch(/movers/i);
    expect((await call(other, "GET", `/api/search?workspaceId=${workspaceId}&q=catering`)).json.chats).toHaveLength(0);
    expect((await call(member, "GET", `/api/search?workspaceId=${workspaceId}&q=office`)).json.projects).toHaveLength(1);

    const moved = await call(member, "PATCH", `/api/chats/${firstChat}`, { projectId: null });
    expect(moved.json).toMatchObject({ projectId: null, sharedToProject: false });
    expect((await call(other, "GET", `/api/chats/${firstChat}`)).status).toBe(404);
    expect((await call(member, "GET", `/api/chats?workspaceId=${workspaceId}`)).json).toHaveLength(1);

    await call(member, "PATCH", `/api/chats/${firstChat}`, { archived: true });
    expect((await call(member, "GET", `/api/chats?workspaceId=${workspaceId}`)).json).toHaveLength(0);
    expect((await call(member, "GET", `/api/chats?workspaceId=${workspaceId}&archived=1`)).json[0].id).toBe(firstChat);
  });

  it("only the owner or an admin deletes a project; library files survive", async () => {
    await call(member, "PUT", `/api/projects/${projectId}/members`, { userId: otherId, role: "edit" });
    expect((await call(other, "DELETE", `/api/projects/${projectId}`)).status).toBe(403);
    const sources = (await call(member, "GET", `/api/projects/${projectId}`)).json.sources;
    const note = sources.find((s: { projectOnly: boolean }) => s.projectOnly);
    expect((await call(member, "DELETE", `/api/projects/${projectId}`)).status).toBe(200);
    expect((await call(member, "GET", `/api/documents/${note.id}`)).status).toBe(404);
    expect((await call(member, "GET", `/api/documents/${libraryDoc}`)).status).toBe(200);
    expect((await call(member, "GET", `/api/chats/${firstChat}`)).status).toBe(200);
  });
});

/* ───────────── Phase B: branches, temporary chats, labels, versions, spreadsheets, export ───────────── */

d("Phase B", () => {
  const owner = jar();
  let workspaceId = "";
  let chatId = "";
  const ids: Record<string, string> = {};

  const startOf = (body: string) => JSON.parse(body.split("event: start\ndata: ")[1]!.split("\n")[0]!);
  const doneOf = (body: string) => JSON.parse(body.split("event: done\ndata: ")[1]!.split("\n")[0]!);
  async function say(content: string | undefined, extra: Record<string, unknown> = {}) {
    const r = await call(owner, "POST", `/api/chats/${chatId}/messages`, { content, ...extra });
    expect(r.status).toBe(200);
    return { start: startOf(r.body), done: doneOf(r.body), body: r.body };
  }
  async function upload(path: string, name: string, content: Buffer | string, fields: Record<string, string> = {}) {
    const { body, contentType } = multipart(fields, { name, content });
    const res = await app.inject({ method: "POST", url: path, headers: { origin: APP_URL, cookie: owner.cookie, "content-type": contentType }, payload: body });
    return res.json();
  }
  async function waitDoc(id: string) {
    for (let i = 0; i < 100; i++) {
      const r = await call(owner, "GET", `/api/documents/${id}`);
      if (r.json.status !== "processing") return r.json;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error("still processing");
  }

  beforeAll(async () => {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const storageDir = await mkdtemp(`${tmpdir()}/aatmiq-b-`);
    await app?.close();
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '%drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    app = await buildApp(db, { ...cfg, storageDir });
    await call(owner, "POST", "/api/setup", { orgName: "Bee Co", name: "Owner", email: "o@b.test", password: "correct-horse-battery" });
    workspaceId = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
  });

  it("editing a message starts a new branch; the old one stays", async () => {
    chatId = (await call(owner, "POST", "/api/chats", { workspaceId })).json.id;
    const a = await say("First question");
    ids.a = a.done.messageId;
    const b = await say("Second question");
    ids.bUser = b.start.userMessageId;
    ids.b = b.done.messageId;
    expect(b.start.parentId).toBe(ids.a);
    // Edit "Second question": continue from the first answer instead.
    const b2 = await say("Second question, reworded", { parentId: ids.a });
    ids.b2User = b2.start.userMessageId;
    ids.b2 = b2.done.messageId;
    const full = await call(owner, "GET", `/api/chats/${chatId}`);
    expect(full.json.messages).toHaveLength(6);
    expect(full.json.leafMessageId).toBe(ids.b2);
    const parent = (id?: string) => full.json.messages.find((m: { id: string }) => m.id === id).parentId;
    expect(parent(ids.bUser)).toBe(ids.a);
    expect(parent(ids.b2User)).toBe(ids.a);
  });

  it("regenerating adds a sibling answer without repeating the question", async () => {
    const r = await say(undefined, { regenerateOf: ids.b2User });
    expect(r.start.userMessageId).toBe(ids.b2User);
    const full = await call(owner, "GET", `/api/chats/${chatId}`);
    expect(full.json.messages).toHaveLength(7);
    expect(full.json.messages.filter((m: { parentId: string }) => m.parentId === ids.b2User)).toHaveLength(2);
    expect(full.json.leafMessageId).toBe(r.done.messageId);
    expect((await call(owner, "POST", `/api/chats/${chatId}/messages`, { regenerateOf: ids.a })).status).toBe(400);
    expect((await call(owner, "POST", `/api/chats/${chatId}/messages`, {})).status).toBe(400);
  });

  it("switches branches and exports the branch being shown", async () => {
    expect((await call(owner, "PATCH", `/api/chats/${chatId}`, { leafMessageId: ids.b })).status).toBe(200);
    const md = await call(owner, "GET", `/api/chats/${chatId}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.body).toContain("Second question");
    expect(md.body).not.toContain("reworded");
    const res = await app.inject({ method: "GET", url: `/api/chats/${chatId}/export?format=docx`, headers: { origin: APP_URL, cookie: owner.cookie } });
    expect(res.headers["content-type"]).toContain("wordprocessingml");
    expect(res.headers["content-disposition"]).toContain("First question.docx");
    expect(res.rawPayload.subarray(0, 2).toString()).toBe("PK");
    const one = await call(owner, "GET", `/api/chats/${chatId}/export?format=md&messageId=${ids.a}`);
    expect(one.body).toContain("Answer from");
    expect(one.body).not.toContain("Second question");
    expect((await call(owner, "PATCH", `/api/chats/${chatId}`, { leafMessageId: "nope" })).status).toBe(400);
  });

  it("temporary chats stay out of lists and search, and are purged after a day", async () => {
    const t = await call(owner, "POST", "/api/chats", { workspaceId, temporary: true });
    chatId = t.json.id;
    await say("Temporary thought about zebras");
    expect((await call(owner, "GET", `/api/chats?workspaceId=${workspaceId}`)).json.map((c: { id: string }) => c.id)).not.toContain(chatId);
    expect((await call(owner, "GET", `/api/search?workspaceId=${workspaceId}&q=zebras`)).json.chats).toHaveLength(0);
    const { purgeTemporaryChats } = await import("./routes/chat");
    await purgeTemporaryChats(db);
    expect((await call(owner, "GET", `/api/chats/${chatId}`)).status).toBe(200);
    await db.execute(sql`update chat set updated_at = now() - interval '2 days' where id = ${chatId}`);
    await purgeTemporaryChats(db);
    expect((await call(owner, "GET", `/api/chats/${chatId}`)).status).toBe(404);
  });

  it("keeping a temporary chat saves it", async () => {
    chatId = (await call(owner, "POST", "/api/chats", { workspaceId, temporary: true })).json.id;
    await say("Keep me");
    expect((await call(owner, "PATCH", `/api/chats/${chatId}`, { temporary: false })).status).toBe(200);
    expect((await call(owner, "GET", `/api/chats?workspaceId=${workspaceId}`)).json.map((c: { id: string }) => c.id)).toContain(chatId);
  });

  it("new versions replace old ones in answers; labels travel with citations", async () => {
    const p = (await call(owner, "POST", "/api/projects", { workspaceId, name: "Pricing" })).json;
    const v1 = await upload(`/api/projects/${p.id}/sources/upload`, "prices.md", "The standard seat price is 900 rupees per month.");
    await waitDoc(v1.id);
    await call(owner, "PATCH", `/api/projects/${p.id}/sources/${v1.id}`, { label: "assumption" });
    const v2 = await upload(`/api/projects/${p.id}/sources/upload`, "prices-v2.md", "The standard seat price is 1100 rupees per month.", { replaces: v1.id });
    await waitDoc(v2.id);
    const proj = (await call(owner, "GET", `/api/projects/${p.id}`)).json;
    const byId = (id: string) => proj.sources.find((s: { id: string }) => s.id === id);
    expect(byId(v1.id).supersededById).toBe(v2.id);
    expect(byId(v2.id).label).toBe("assumption"); // carried over from the version it replaces

    chatId = (await call(owner, "POST", "/api/chats", { workspaceId, projectId: p.id })).json.id;
    const r = await say("What is the seat price?");
    expect(r.start.citations.map((c: { name: string }) => c.name)).toEqual(["prices-v2.md"]);
    expect(r.start.citations[0].label).toBe("assumption");

    await call(owner, "PATCH", `/api/projects/${p.id}/sources/${v2.id}`, { label: "confirmed" });
    await call(owner, "PATCH", `/api/projects/${p.id}/sources/${v1.id}`, { supersededById: null });
    const again = await say("And the seat price now?");
    expect(again.start.citations.map((c: { name: string }) => c.name).sort()).toEqual(["prices-v2.md", "prices.md"]);
    expect((await call(owner, "PATCH", `/api/projects/${p.id}/sources/${v1.id}`, { supersededById: v1.id })).status).toBe(400);
  });

  it("a broken image fails with a clear error instead of crashing", async () => {
    const doc = await upload("/api/documents", "fake.png", "definitely not an image", { workspaceId, scope: "private" });
    const r = await waitDoc(doc.id);
    expect(r.status).toBe("failed");
    expect(r.error).toContain("couldn't be read");
  });

  it("answers from an Excel workbook", async () => {
    const { readFile } = await import("node:fs/promises");
    const xlsx = await readFile(new URL("../test/fixtures/budget.xlsx", import.meta.url));
    const doc = await upload("/api/documents", "budget.xlsx", xlsx, { workspaceId, scope: "private" });
    const ready = await waitDoc(doc.id);
    expect(ready.status).toBe("ready");
    chatId = (await call(owner, "POST", "/api/chats", { workspaceId })).json.id;
    const r = await say("What do servers cost?", { documentIds: [doc.id] });
    expect(r.start.citations[0]).toMatchObject({ name: "budget.xlsx" });
    expect(r.body).toContain("Servers | 12000");
  });
});
