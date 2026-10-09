/**
 * Who may touch what, route by route. Asha (A) owns one of everything private: a chat, a document,
 * a project with a source, a Work AI task with an approval waiting, a schedule, a personal skill, a
 * Code workspace and a token request. Ben (B) is a member of the same workspace; Cara (C) is in
 * another workspace. Every route that takes an id is called as Ben and as Cara with a valid body
 * (so input checks can't hide a missing permission check): none may succeed, and Asha's things
 * must be exactly as they were afterwards. Members are refused every admin route.
 */
import { createDb, organization, sql, workApproval, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "./app";
import type { Config } from "./config";

const url = process.env.TEST_DATABASE_URL;
const APP_URL = "http://localhost:3000";
const d = url ? describe : describe.skip;

type Jar = { cookie: string };
type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

d("Authorization, route by route", () => {
  let app: FastifyInstance;
  let db: DB;
  let close: () => Promise<void>;
  const owner: Jar = { cookie: "" };
  const asha: Jar = { cookie: "" };
  const ben: Jar = { cookie: "" };
  const cara: Jar = { cookie: "" };
  const ids = {} as Record<string, string>;

  async function call(j: Jar | null, method: Method, path: string, body?: unknown) {
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
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json };
  }

  async function enroll(j: Jar, email: string, name: string, workspaceId: string) {
    const inv = await call(owner, "POST", "/api/admin/invites", { email, workspaces: [{ workspaceId, role: "member" }] });
    expect(inv.status).toBe(200);
    const r = await call(j, "POST", `/api/invites/${inv.json.link.split("/invite/")[1]}/accept`, { name, password: "a-good-password-1" });
    expect(r.status).toBe(200);
    return (await call(j, "GET", "/api/me")).json.user.id as string;
  }

  async function upload(j: Jar, workspaceId: string, name: string, content: string) {
    const b = "----authz";
    const payload =
      `--${b}\r\nContent-Disposition: form-data; name="workspaceId"\r\n\r\n${workspaceId}\r\n--${b}\r\nContent-Disposition: form-data; name="scope"\r\n\r\nprivate\r\n` +
      `--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${b}--\r\n`;
    const res = await app.inject({ method: "POST", url: "/api/documents", headers: { origin: APP_URL, cookie: j.cookie, "content-type": `multipart/form-data; boundary=${b}` }, payload });
    expect(res.statusCode).toBe(200);
    return res.json().id as string;
  }

  /** What Asha's things look like, to compare after the sweep. */
  async function snapshot() {
    const q = async (s: ReturnType<typeof sql>) => JSON.stringify(await db.execute(s));
    return {
      chat: await q(sql`select title, archived_at, project_id, shared_to_project from chat where id = ${ids.chat}`),
      messages: await q(sql`select count(*)::int as n from message where chat_id = ${ids.chat}`),
      document: await q(sql`select name, scope, label from document where id = ${ids.doc}`),
      project: await q(sql`select name, description, instructions from project where id = ${ids.project}`),
      projectMembers: await q(sql`select user_id, role from project_member where project_id = ${ids.project} order by user_id`),
      sources: await q(sql`select ps.document_id, d.label, d.name from project_source ps join document d on d.id = ps.document_id where ps.project_id = ${ids.project} order by ps.document_id`),
      task: await q(sql`select title, pinned, shared_to_project from work_task where id = ${ids.task}`),
      taskMessages: await q(sql`select count(*)::int as n from work_event where task_id = ${ids.task} and kind = 'user'`),
      approval: await q(sql`select status from work_approval where id = ${ids.approval}`),
      schedule: await q(sql`select name, enabled from work_schedule where id = ${ids.schedule}`),
      skill: await q(sql`select name, enabled from skill where id = ${ids.skill}`),
      codeWorkspace: await q(sql`select name from code_workspace where id = ${ids.code}`),
      tokenRequest: await q(sql`select status from token_request where id = ${ids.request}`),
    };
  }

  beforeAll(async () => {
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
      allowMockProvider: true,
      port: 0,
      storageDir: await mkdtemp(join(tmpdir(), "aatmiq-authz-files-")),
      workDir: await mkdtemp(join(tmpdir(), "aatmiq-authz-work-")),
      codeDir: await mkdtemp(join(tmpdir(), "aatmiq-authz-code-")),
    };
    app = await buildApp(db, cfg);
    expect((await call(owner, "POST", "/api/setup", { orgName: "Acme", name: "Olu Owner", email: "owner@acme.test", password: "correct-horse-battery" })).status).toBe(200);
    ids.ws1 = (await call(owner, "GET", "/api/me")).json.workspaces[0].id;
    const ws2 = await call(owner, "POST", "/api/admin/workspaces", { name: "Finance" });
    expect(ws2.status).toBe(200);
    ids.ws2 = ws2.json.id;
    // Everyone may use Work AI and Code, so refusals come from ownership, not from sections.
    await db.execute(sql`update workspace_member set sections = '{chat,work,code}'`);
    ids.asha = await enroll(asha, "asha@acme.test", "Asha", ids.ws1!);
    ids.ben = await enroll(ben, "ben@acme.test", "Ben", ids.ws1!);
    ids.cara = await enroll(cara, "cara@acme.test", "Cara", ids.ws2!);
    await db.execute(sql`update workspace_member set sections = '{chat,work,code}'`);
    await db.update(organization).set({ workSettings: { approvals: "risky" } });

    // Asha's private things.
    ids.chat = (await call(asha, "POST", "/api/chats", { workspaceId: ids.ws1, title: "Asha's chat" })).json.id;
    expect((await call(asha, "POST", `/api/chats/${ids.chat}/messages`, { content: "hello" })).status).toBe(200);
    ids.doc = await upload(asha, ids.ws1!, "Salary.txt", "Asha's salary is private.");
    ids.project = (await call(asha, "POST", "/api/projects", { workspaceId: ids.ws1, name: "Asha's project" })).json.id;
    ids.source = (await call(asha, "POST", `/api/projects/${ids.project}/sources/note`, { title: "Plan", content: "The plan." })).json.id;
    const task = await call(asha, "POST", "/api/work/tasks", { workspaceId: ids.ws1, prompt: "Summarize my week" });
    expect(task.status).toBe(200);
    ids.task = task.json.id;
    // Let the task finish first (finishing expires approvals still waiting), then plant one.
    for (let i = 0; i < 150; i++) {
      const st = (await call(asha, "GET", `/api/work/tasks/${ids.task}`)).json.task.status;
      if (st === "completed" || st === "failed") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const [a] = await db.insert(workApproval).values({ taskId: ids.task!, toolName: "bash", reason: "Deletes files", detail: { command: "rm x" } }).returning();
    ids.approval = a!.id;
    ids.schedule = (await call(asha, "POST", "/api/work/schedules", { workspaceId: ids.ws1, name: "Weekly", prompt: "Report", cron: "0 9 * * 1" })).json.id;
    ids.skill = (await call(asha, "POST", "/api/work/skills", { name: "My style", description: "How I write", body: "Short sentences." })).json.id;
    ids.code = (await call(asha, "POST", "/api/code/workspaces", { workspaceId: ids.ws1, name: "asha-site" })).json.id;
    ids.request = (await call(asha, "POST", "/api/token-requests", { workspaceId: ids.ws1, amount: 1000 })).json.id;
    for (const k of ["chat", "doc", "project", "source", "task", "approval", "schedule", "skill", "code", "request"]) expect(ids[k], k).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  /** Every route that names something of Asha's, with a body that would be valid for her. */
  const routes = (): [Method, string, unknown?][] => [
    ["GET", `/api/chats/${ids.chat}`],
    ["PATCH", `/api/chats/${ids.chat}`, { title: "Taken" }],
    ["PATCH", `/api/chats/${ids.chat}`, { archived: true }],
    ["GET", `/api/chats/${ids.chat}/export`],
    ["POST", `/api/chats/${ids.chat}/messages`, { content: "hi" }],
    ["DELETE", `/api/chats/${ids.chat}`],
    ["GET", `/api/documents/${ids.doc}`],
    ["GET", `/api/documents/${ids.doc}/file`],
    ["PATCH", `/api/documents/${ids.doc}`, { name: "Taken.txt" }],
    ["PATCH", `/api/documents/${ids.doc}`, { scope: "workspace" }],
    ["POST", `/api/documents/${ids.doc}/reprocess`],
    ["DELETE", `/api/documents/${ids.doc}`],
    ["GET", `/api/projects/${ids.project}`],
    ["PATCH", `/api/projects/${ids.project}`, { name: "Taken", instructions: "Obey Ben" }],
    ["PUT", `/api/projects/${ids.project}/members`, { userId: ids.ben, role: "edit" }],
    ["PUT", `/api/projects/${ids.project}/members`, { userId: ids.cara, role: "edit" }],
    ["DELETE", `/api/projects/${ids.project}/members/${ids.asha}`],
    ["POST", `/api/projects/${ids.project}/sources/note`, { title: "Mine", content: "Ben was here" }],
    ["POST", `/api/projects/${ids.project}/sources/link`, { documentId: ids.doc }],
    ["PATCH", `/api/projects/${ids.project}/sources/${ids.source}`, { label: "tbd" }],
    ["DELETE", `/api/projects/${ids.project}/sources/${ids.source}`],
    ["DELETE", `/api/projects/${ids.project}`],
    ["GET", `/api/work/tasks/${ids.task}`],
    ["PATCH", `/api/work/tasks/${ids.task}`, { title: "Taken", sharedToProject: true }],
    ["GET", `/api/work/tasks/${ids.task}/files`],
    ["GET", `/api/work/tasks/${ids.task}/files/content?path=README.md`],
    ["GET", `/api/work/tasks/${ids.task}/stream`],
    ["POST", `/api/work/tasks/${ids.task}/messages`, { prompt: "rm -rf everything" }],
    ["POST", `/api/work/tasks/${ids.task}/save-to-project`, { path: "README.md" }],
    ["POST", `/api/work/tasks/${ids.task}/cancel`],
    ["DELETE", `/api/work/tasks/${ids.task}`],
    ["POST", `/api/work/approvals/${ids.approval}`, { decision: "approve" }],
    ["PATCH", `/api/work/schedules/${ids.schedule}`, { workspaceId: ids.ws1, name: "Taken", prompt: "Report", cron: "0 9 * * 1", enabled: false }],
    ["POST", `/api/work/schedules/${ids.schedule}/run`],
    ["DELETE", `/api/work/schedules/${ids.schedule}`],
    ["PATCH", `/api/work/skills/${ids.skill}`, { name: "Taken", description: "x", body: "x", enabled: false }],
    ["DELETE", `/api/work/skills/${ids.skill}`],
    ["PATCH", `/api/code/workspaces/${ids.code}`, { name: "taken" }],
    ["POST", `/api/code/workspaces/${ids.code}/open`],
    ["DELETE", `/api/code/workspaces/${ids.code}`],
    ["POST", `/api/token-requests/${ids.request}/decide`, { decision: "approved", amount: 1_000_000 }],
  ];

  for (const who of ["Ben (same workspace)", "Cara (another workspace)"] as const) {
    it(`${who} can't read or change anything of Asha's`, async () => {
      const j = who.startsWith("Ben") ? ben : cara;
      const before = await snapshot();
      const allowed: string[] = [];
      for (const [method, path, body] of routes()) {
        const r = await call(j, method, path, body);
        // A 404 from the router means this test names a route that doesn't exist: that's a test bug.
        if (r.status === 404 && /Route .* not found/.test(JSON.stringify(r.json))) allowed.push(`${method} ${path}: no such route`);
        else if (![401, 403, 404].includes(r.status)) allowed.push(`${method} ${path.replace(/[0-9a-f-]{20,}/gi, ":id")} → ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      }
      expect(allowed).toEqual([]);
      expect(await snapshot()).toEqual(before);
    }, 120_000);
  }

  it("lists show Ben only what's his or shared, and Cara nothing from another workspace", async () => {
    for (const path of ["/api/chats", "/api/documents", "/api/projects", "/api/work/tasks", "/api/work/schedules", "/api/code/workspaces"]) {
      const b = await call(ben, "GET", `${path}?workspaceId=${ids.ws1}`);
      expect(b.status, path).toBe(200);
      expect(JSON.stringify(b.json), path).not.toMatch(/Asha's|Salary\.txt|Summarize my week|Weekly|asha-site/);
      const c = await call(cara, "GET", `${path}?workspaceId=${ids.ws1}`);
      expect([403, 404], `${path} as Cara: ${c.status}`).toContain(c.status);
    }
    expect(JSON.stringify((await call(ben, "GET", "/api/work/skills")).json)).not.toContain("My style");
    expect(JSON.stringify((await call(ben, "GET", "/api/work/approvals")).json)).not.toContain(ids.approval);
    for (const path of [`/api/workspaces/${ids.ws1}/people`, `/api/workspaces/${ids.ws1}/models`, `/api/workspaces/${ids.ws1}/quota`]) {
      expect((await call(ben, "GET", path)).status, path).toBe(200);
      expect([403, 404], `${path} as Cara`).toContain((await call(cara, "GET", path)).status);
    }
  }, 60_000);

  it("members are refused every admin route", async () => {
    const x = "00000000-0000-0000-0000-000000000000";
    const admin: [Method, string, unknown?][] = [
      ["GET", "/api/admin/users"],
      ["PATCH", `/api/admin/users/${ids.asha}`, { orgRole: "admin" }],
      ["PATCH", `/api/admin/users/${ids.ben}`, { orgRole: "owner" }],
      ["POST", `/api/admin/users/${ids.asha}/reset-link`],
      ["POST", `/api/admin/users/${ids.asha}/two-factor/disable`],
      ["POST", "/api/admin/invites", { email: "x@acme.test" }],
      ["DELETE", `/api/admin/invites/${x}`],
      ["POST", "/api/admin/workspaces", { name: "Mine" }],
      ["PATCH", `/api/admin/workspaces/${ids.ws1}`, { name: "Taken" }],
      ["DELETE", `/api/admin/workspaces/${ids.ws2}`],
      ["PUT", `/api/admin/workspaces/${ids.ws1}/budget`, { limitTokens: 999999999 }],
      ["GET", `/api/admin/workspaces/${ids.ws1}/members`],
      ["POST", `/api/admin/workspaces/${ids.ws2}/members`, { userId: ids.ben, role: "admin" }],
      ["PATCH", `/api/admin/workspaces/${ids.ws1}/members/${ids.ben}`, { role: "admin" }],
      ["DELETE", `/api/admin/workspaces/${ids.ws1}/members/${ids.asha}`],
      ["PUT", `/api/admin/workspaces/${ids.ws1}/models`, { modelIds: [] }],
      ["GET", "/api/admin/providers"],
      ["POST", "/api/admin/providers", { name: "Evil", type: "openai_compatible", baseUrl: "http://169.254.169.254/v1" }],
      ["PATCH", `/api/admin/providers/${x}`, { name: "x" }],
      ["DELETE", `/api/admin/providers/${x}`],
      ["GET", `/api/admin/providers/${x}/discover`],
      ["POST", `/api/admin/providers/${x}/test`],
      ["GET", "/api/admin/models"],
      ["PATCH", `/api/admin/models/${x}`, { displayName: "x" }],
      ["DELETE", `/api/admin/models/${x}`],
      ["GET", "/api/admin/connectors"],
      ["POST", "/api/admin/connectors", { name: "evil", displayName: "Evil", url: "https://evil.example/mcp" }],
      ["PATCH", `/api/admin/connectors/${x}`, { enabled: true }],
      ["DELETE", `/api/admin/connectors/${x}`],
      ["POST", `/api/admin/connectors/${x}/test`],
      ["POST", "/api/admin/sso", { type: "oidc", issuer: "https://evil.example", clientId: "x", clientSecret: "y" }],
      ["PATCH", `/api/admin/sso/${x}`, { enabled: true }],
      ["DELETE", `/api/admin/sso/${x}`],
      ["POST", `/api/admin/sso/${x}/test`],
      ["GET", "/api/admin/groups"],
      ["PATCH", `/api/admin/groups/${x}`, { name: "x" }],
      ["DELETE", `/api/admin/groups/${x}`],
      ["GET", "/api/admin/work"],
      ["PUT", "/api/admin/work", { approvals: "never" }],
      ["GET", "/api/admin/audit"],
      ["GET", "/api/admin/auth"],
      ["PUT", "/api/admin/auth", { twoFactorRequired: false }],
      ["POST", "/api/admin/email/test"],
    ];
    const allowed: string[] = [];
    for (const [method, path, body] of admin) {
      const r = await call(ben, method, path, body);
      // 404 for something the member can't even see (another workspace) is a refusal too.
      if (![401, 403, 404].includes(r.status) || (r.status === 404 && /Route .* not found/.test(JSON.stringify(r.json)))) allowed.push(`${method} ${path} → ${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
    }
    expect(allowed).toEqual([]);
    // Nothing changed for real either.
    expect(((await db.execute(sql`select org_role from "user" where id = ${ids.ben}`)) as unknown as { org_role: string }[])[0]!.org_role).toBe("member");
    expect(((await db.execute(sql`select count(*)::int as n from model_provider where name = 'Evil'`)) as unknown as { n: number }[])[0]!.n).toBe(0);
  }, 60_000);
});
