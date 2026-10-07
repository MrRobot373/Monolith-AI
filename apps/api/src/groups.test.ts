/** Groups: models and a token budget across workspaces; who pays for which call. */
import { createDb, sql, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

type Jar = { cookie: string };
const jar = (): Jar => ({ cookie: "" });

d("Groups", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  const owner = jar();
  const maya = jar();
  const ravi = jar();
  let ws1 = "";
  let ws2 = "";
  let demoId = "";
  let bigId = "";
  let mayaId = "";
  let raviId = "";
  let groupId = "";

  async function call(j: Jar | null, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown) {
    const res = await app.inject({
      method,
      url: path,
      headers: { origin: APP_URL, ...(j?.cookie ? { cookie: j.cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      payload: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const set = res.headers["set-cookie"];
    if (j && set) j.cookie = (Array.isArray(set) ? set : [set]).map((c) => c.split(";")[0]).join("; ");
    let json: any = null;
    try {
      json = res.json();
    } catch {}
    return { status: res.statusCode, json };
  }
  async function join(j: Jar, email: string, name: string) {
    const inv = await call(owner, "POST", "/api/admin/invites", { email, workspaces: [{ workspaceId: ws1, role: "member" }] });
    await call(j, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name, password: "a-good-password-1" });
    return (await call(j, "GET", "/api/me")).json.user.id as string;
  }
  async function chat(j: Jar, workspaceId: string, modelId: string, content = "Hello there") {
    const c = await call(j, "POST", "/api/chats", { workspaceId, modelId });
    return call(j, "POST", `/api/chats/${c.json.id}/messages`, { content, modelId });
  }
  const lastUsage = async () =>
    ((await db.execute(sql`select group_id, model_id, workspace_id from usage_event where section = 'chat' order by created_at desc limit 1`)) as unknown as { group_id: string | null; model_id: string; workspace_id: string }[])[0]!;

  beforeAll(async () => {
    ({ db, close } = createDb(url));
    await db.execute(sql`
      do $$ declare r record; begin
        for r in (select tablename from pg_tables where schemaname = 'public' and tablename not like '__drizzle%') loop
          execute 'truncate table "' || r.tablename || '" cascade';
        end loop;
      end $$;`);
    const cfg: Config = { appUrl: APP_URL, databaseUrl: url!, secret: "test-secret-test-secret-test-secret-1234", allowMockProvider: true, port: 0, storageDir: "" };
    app = await buildApp(db, cfg);
    await call(owner, "POST", "/api/setup", { orgName: "Acme", name: "Asha Owner", email: "owner@acme.test", password: "correct-horse-battery" });
    ws1 = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    demoId = (await call(owner, "GET", `/api/workspaces/${ws1}/models?section=chat`)).json[0].id;
    // A second model on the demo provider that no workspace offers.
    const [row] = (await db.execute(sql`insert into model (provider_id, model_key, display_name, context_length)
      select provider_id, 'aatmiq-big', 'Big Model', 32768 from model where id = ${demoId} returning id`)) as unknown as { id: string }[];
    bigId = row!.id;
    mayaId = await join(maya, "maya@acme.test", "Maya Patel");
    raviId = await join(ravi, "ravi@acme.test", "Ravi Kumar");
    ws2 = (await call(owner, "POST", "/api/admin/workspaces", { name: "Research" })).json.id;
    await call(owner, "PUT", `/api/admin/workspaces/${ws2}/models`, { modelIds: [demoId] });
    await call(owner, "POST", `/api/admin/workspaces/${ws2}/members`, { userId: mayaId, role: "member" });
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it("only admins manage groups; names are unique; members and models must exist", async () => {
    expect((await call(maya, "GET", "/api/admin/groups")).status).toBe(403);
    expect((await call(maya, "POST", "/api/admin/groups", { name: "Sneaky" })).status).toBe(403);
    expect((await call(owner, "POST", "/api/admin/groups", { name: "Bad", memberIds: ["nobody"] })).status).toBe(400);
    expect((await call(owner, "POST", "/api/admin/groups", { name: "Bad", modelIds: ["nothing"] })).status).toBe(400);
    const g = await call(owner, "POST", "/api/admin/groups", { name: "Engineering", description: "Builders", tokenLimit: 1000, memberIds: [mayaId, raviId], modelIds: [bigId] });
    expect(g.status).toBe(200);
    groupId = g.json.id;
    expect((await call(owner, "POST", "/api/admin/groups", { name: "Engineering" })).status).toBe(409);
  });

  it("members see the group's models in every workspace, marked with the group; others don't", async () => {
    const mine = (await call(maya, "GET", `/api/workspaces/${ws2}/models?section=chat`)).json as { id: string; groups: { name: string }[] }[];
    expect(mine.find((m) => m.id === bigId)?.groups).toEqual([{ id: groupId, name: "Engineering" }]);
    expect(mine.find((m) => m.id === demoId)?.groups).toEqual([]);
    await call(owner, "PATCH", `/api/admin/groups/${groupId}`, { memberIds: [mayaId] });
    const theirs = (await call(ravi, "GET", `/api/workspaces/${ws1}/models?section=chat`)).json as { id: string }[];
    expect(theirs.map((m) => m.id)).toEqual([demoId]);
    const refused = await chat(ravi, ws1, bigId);
    expect(refused.status).toBe(400);
  });

  it("the group pays for its own models; the workspace budget is untouched", async () => {
    await call(owner, "PUT", `/api/admin/workspaces/${ws1}/budget`, { tokenLimit: 1_000_000 });
    const before = (await call(maya, "GET", `/api/workspaces/${ws1}/quota`)).json;
    const r = await chat(maya, ws1, bigId);
    expect(r.status).toBe(200);
    const u = await lastUsage();
    expect(u).toMatchObject({ group_id: groupId, model_id: bigId, workspace_id: ws1 });
    const after = (await call(maya, "GET", `/api/workspaces/${ws1}/quota`)).json;
    expect(after.user.used).toBe(before.user.used);
    expect(after.scope).toEqual({ kind: "workspace" });
    const g = (await call(maya, "GET", `/api/workspaces/${ws1}/quota?modelId=${bigId}`)).json;
    expect(g.scope).toEqual({ kind: "group", id: groupId, name: "Engineering" });
    expect(g.user.used).toBeGreaterThan(0);
    // With one member the whole group budget is theirs.
    expect(g.user.limit).toBe(1000);
  });

  it("a model the workspace offers is paid by the workspace even when a group gives it too", async () => {
    await call(owner, "PATCH", `/api/admin/groups/${groupId}`, { modelIds: [bigId, demoId] });
    expect((await chat(maya, ws1, demoId)).status).toBe(200);
    expect((await lastUsage()).group_id).toBeNull();
  });

  it("the group budget is shared across workspaces and split evenly; the per-person amount wins", async () => {
    await call(owner, "PATCH", `/api/admin/groups/${groupId}`, { memberIds: [mayaId, raviId], tokenLimit: 1000, memberTokenLimit: null });
    expect((await call(ravi, "GET", `/api/workspaces/${ws1}/quota?modelId=${bigId}`)).json.user.limit).toBe(500);
    await call(owner, "PATCH", `/api/admin/groups/${groupId}`, { memberTokenLimit: 1 });
    // Maya has used more than 1 token of the group's budget: blocked in any workspace for the group's model…
    const blocked = await chat(maya, ws2, bigId);
    expect(blocked.status).toBe(402);
    expect(blocked.json.error).toContain("Engineering group");
    expect(blocked.json.details.scope.kind).toBe("group");
    // (Work AI is on for Maya in the first workspace; she joined the second with Chat only.)
    const work = await call(maya, "POST", "/api/work/tasks", { workspaceId: ws1, prompt: "Summarize the notes", modelId: bigId });
    expect(work.status).toBe(402);
    expect(work.json.error).toContain("Engineering group");
    // …while the workspace's own model still works there.
    expect((await chat(maya, ws2, demoId)).status).toBe(200);
    // Ravi has his own share.
    expect((await chat(ravi, ws1, bigId)).status).toBe(200);
  });

  it("admins see usage per group and person; people see their groups; Users lists groups", async () => {
    const list = (await call(owner, "GET", "/api/admin/groups")).json;
    const g = list.find((x: { id: string }) => x.id === groupId);
    expect(g).toMatchObject({ name: "Engineering", description: "Builders", tokenLimit: 1000, memberTokenLimit: 1 });
    expect(g.used).toBeGreaterThan(0);
    expect(g.members.map((m: { email: string }) => m.email).sort()).toEqual(["maya@acme.test", "ravi@acme.test"]);
    expect(g.members.every((m: { used: number }) => m.used > 0)).toBe(true);
    expect(g.models.map((m: { displayName: string }) => m.displayName)).toEqual(["Aatmiq Demo", "Big Model"]);
    const mine = (await call(maya, "GET", "/api/me/groups")).json;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ name: "Engineering", quota: { scope: { kind: "group" }, result: { allowed: false } } });
    const users = (await call(owner, "GET", "/api/admin/users")).json as { email: string; groups: { name: string }[] }[];
    expect(users.find((u) => u.email === "maya@acme.test")!.groups.map((x) => x.name)).toEqual(["Engineering"]);
    // Workspace budget views leave out what the group paid for.
    const members = (await call(owner, "GET", `/api/admin/workspaces/${ws1}/members`)).json as { email: string; used: number }[];
    const ravisWorkspaceUse = members.find((m) => m.email === "ravi@acme.test")!.used;
    expect(ravisWorkspaceUse).toBe(0);
  });

  it("deleting a group takes its models away; its past usage stays out of workspace budgets", async () => {
    expect((await call(maya, "DELETE", `/api/admin/groups/${groupId}`)).status).toBe(403);
    expect((await call(owner, "DELETE", `/api/admin/groups/${groupId}`)).status).toBe(200);
    expect((await call(owner, "DELETE", `/api/admin/groups/${groupId}`)).status).toBe(404);
    const models = (await call(maya, "GET", `/api/workspaces/${ws1}/models?section=chat`)).json as { id: string }[];
    expect(models.map((m) => m.id)).toEqual([demoId]);
    expect((await call(ravi, "GET", `/api/workspaces/${ws1}/quota`)).json.user.used).toBe(0);
    const actions = (await db.execute(sql`select action from audit_log where action like 'group.%'`)) as unknown as { action: string }[];
    expect(new Set(actions.map((a) => a.action))).toEqual(new Set(["group.created", "group.updated", "group.deleted"]));
  });
});
