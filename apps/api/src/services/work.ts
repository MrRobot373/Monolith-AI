/**
 * Work AI runner: runs each task's agent runtime, records its timeline and fans events out to
 * whoever is watching. See docs/06-work-ai.md.
 *
 *  - One runtime (DeepSeek Harness process) per active task, in the task's own folder.
 *  - Each person can run a few tasks at once (Admin → Work AI); the rest wait in a queue.
 *  - A finished task keeps its runtime warm for follow-ups, then stops after `idleMinutes`.
 *    A later follow-up starts a new runtime seeded with the task's history.
 *  - The runtime reaches back to /api/internal/work with a per-task token for models,
 *    approvals and web search; nothing else from this server is visible to it.
 */
import {
  and,
  asc,
  connector,
  desc,
  eq,
  inArray,
  notification,
  or,
  organization,
  skill,
  workApproval,
  workEvent,
  workTask,
  sql,
  type DB,
} from "@aatmiq/db";
import { createDshEngine, type HarnessEngine, type HarnessEvent, type TaskRuntime } from "@aatmiq/harness";
import { DEFAULT_WORK_SETTINGS, PRODUCT_NAME, type WorkSettingsValue } from "@aatmiq/shared";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AppContext } from "../context";
import { resolveModel } from "./models";

export type TaskStatus = (typeof workTask.$inferSelect)["status"];
export interface WorkStreamEvent {
  seq?: number;
  kind: string;
  data: Record<string, unknown>;
  at?: string;
}
type Listener = (e: WorkStreamEvent) => void;

interface Live {
  taskId: string;
  userId: string;
  workspaceId: string;
  token: string;
  runtime: TaskRuntime | null;
  /** A turn is in progress (or the runtime is starting). */
  busy: boolean;
  cancelled: boolean;
  /** Set by the model proxy when it refused a call (quota, model offline), reported at turn end. */
  lastError: string | null;
  lastAnswer: string;
  idleTimer?: NodeJS.Timeout;
}

const MAX_TOOL_TEXT = 20_000;
const SEED_CHARS = 16_000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function getWorkSettings(db: DB): Promise<WorkSettingsValue> {
  const [org] = await db.select({ s: organization.workSettings }).from(organization).limit(1);
  return { ...DEFAULT_WORK_SETTINGS, ...(org?.s ?? {}) } as WorkSettingsValue;
}

export function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine || "New task";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/** Folder-safe skill slug. */
export function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "skill"
  );
}

export class WorkRunner {
  private live = new Map<string, Live>();
  private byToken = new Map<string, string>();
  private listeners = new Map<string, Set<Listener>>();
  private writes = new Map<string, Promise<unknown>>();
  private seqs = new Map<string, number>();
  private approvalWaiters = new Map<string, Set<() => void>>();
  private engine: HarnessEngine;
  private stopped = false;

  constructor(
    private ctx: AppContext,
    private opts: { controlUrl: () => string; engine?: HarnessEngine; log?: (msg: string, err?: unknown) => void },
  ) {
    this.engine = opts.engine ?? createDshEngine();
  }

  get dir() {
    return resolve(this.ctx.cfg.workDir ?? ".data/work");
  }
  taskDir(taskId: string) {
    return join(this.dir, taskId);
  }
  filesDir(taskId: string) {
    return join(this.taskDir(taskId), "files");
  }

  /* ───────────── Timeline ───────────── */

  subscribe(taskId: string, fn: Listener): () => void {
    let set = this.listeners.get(taskId);
    if (!set) this.listeners.set(taskId, (set = new Set()));
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(taskId);
    };
  }

  private broadcast(taskId: string, e: WorkStreamEvent) {
    for (const fn of this.listeners.get(taskId) ?? []) {
      try {
        fn(e);
      } catch {
        /* a broken stream must not break the task */
      }
    }
  }

  /** Live-only event (streamed text): not stored. */
  pulse(taskId: string, kind: string, data: Record<string, unknown>) {
    this.broadcast(taskId, { kind, data });
  }

  /** Store an event in order and send it to watchers. */
  record(taskId: string, kind: string, data: Record<string, unknown>): Promise<void> {
    const prev = this.writes.get(taskId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(async () => {
        let seq = this.seqs.get(taskId);
        if (seq === undefined) {
          const [r] = await this.ctx.db.select({ n: sql<number | null>`max(${workEvent.seq})` }).from(workEvent).where(eq(workEvent.taskId, taskId));
          seq = r?.n ?? 0;
        }
        seq += 1;
        this.seqs.set(taskId, seq);
        const [row] = await this.ctx.db.insert(workEvent).values({ taskId, seq, kind, data }).returning({ at: workEvent.createdAt });
        this.broadcast(taskId, { seq, kind, data, at: row?.at.toISOString() });
      });
    this.writes.set(taskId, next);
    void next.finally(() => {
      if (this.writes.get(taskId) === next) this.writes.delete(taskId);
    });
    return next.catch((e) => this.opts.log?.("work: recording an event failed", e));
  }

  private async setStatus(taskId: string, status: TaskStatus, extra: Partial<typeof workTask.$inferInsert> = {}) {
    const done = status === "completed" || status === "failed" || status === "cancelled";
    await this.ctx.db
      .update(workTask)
      .set({ status, updatedAt: new Date(), ...(done ? { finishedAt: new Date() } : { finishedAt: null }), ...extra })
      .where(eq(workTask.id, taskId));
    await this.record(taskId, "status", { status, ...(extra.error ? { error: extra.error } : {}) });
  }

  /* ───────────── Lifecycle ───────────── */

  /** Queue the task's latest message: start (or continue) its runtime when the person has a free slot. */
  async submit(taskId: string, prompt: string): Promise<void> {
    await this.record(taskId, "user", { text: prompt });
    const l = this.live.get(taskId);
    if (l?.runtime?.alive && !l.cancelled) {
      clearTimeout(l.idleTimer);
      l.busy = true;
      l.lastError = null;
      await this.setStatus(taskId, "running", { error: null });
      try {
        await l.runtime.send(prompt);
      } catch (e) {
        await this.fail(taskId, e instanceof Error ? e.message : "The agent didn't accept the message.");
      }
      return;
    }
    await this.setStatus(taskId, "queued", { error: null });
    // Starting a runtime takes a moment; the caller doesn't wait for it.
    void this.pump().catch((e) => this.opts.log?.("work: starting a task failed", e));
  }

  /** Start queued tasks while people have free slots (oldest first). */
  private pumping: Promise<void> | null = null;
  async pump(): Promise<void> {
    if (this.stopped) return;
    if (this.pumping) return this.pumping.then(() => this.pump());
    this.pumping = (async () => {
      const settings = await getWorkSettings(this.ctx.db);
      const queued = await this.ctx.db
        .select({ id: workTask.id, userId: workTask.userId })
        .from(workTask)
        // Drafts (created without a message yet) wait until their first message.
        .where(and(eq(workTask.status, "queued"), sql`exists (select 1 from work_event e where e.task_id = ${workTask.id} and e.kind = 'user')`))
        .orderBy(asc(workTask.updatedAt));
      for (const t of queued) {
        if (this.live.has(t.id)) continue;
        const busy = [...this.live.values()].filter((l) => l.userId === t.userId && l.busy).length;
        if (busy >= settings.maxConcurrentPerUser) continue;
        await this.start(t.id, settings);
      }
    })().finally(() => {
      this.pumping = null;
    });
    return this.pumping;
  }

  private async start(taskId: string, settings: WorkSettingsValue) {
    const { db, box } = this.ctx;
    const [task] = await db.select().from(workTask).where(eq(workTask.id, taskId));
    if (!task || task.status !== "queued") return;
    const token = randomBytes(32).toString("hex");
    const l: Live = { taskId, userId: task.userId, workspaceId: task.workspaceId, token, runtime: null, busy: true, cancelled: false, lastError: null, lastAnswer: "" };
    this.live.set(taskId, l);
    this.byToken.set(token, taskId);
    await this.setStatus(taskId, "running");

    try {
      const { model: m } = await resolveModel(db, box, task.workspaceId, "work", task.modelId);
      if (task.modelId !== m.id) await db.update(workTask).set({ modelId: m.id }).where(eq(workTask.id, taskId));
      const workdir = this.filesDir(taskId);
      const homeDir = join(this.taskDir(taskId), "runtime");
      await mkdir(workdir, { recursive: true });
      const skillsDir = await this.writeSkills(task.userId, join(homeDir, "skills"));
      const [org] = await db.select({ productName: organization.productName }).from(organization).limit(1);
      const runtime = await this.engine.start(
        {
          taskId,
          workdir,
          homeDir,
          model: { key: m.id, name: m.displayName, contextWindow: m.contextLength ?? 32_768 },
          controlUrl: this.opts.controlUrl(),
          token,
          approvals: settings.approvals,
          askForNetwork: !settings.allowNetwork,
          webSearch: !!settings.searxngUrl,
          skillsDir,
          connectors: await this.connectorSpecs(),
          productName: org?.productName ?? PRODUCT_NAME,
        },
        (e) => void this.onEvent(l, e).catch((err) => this.opts.log?.("work: handling an event failed", err)),
      );
      l.runtime = runtime;
      await db.update(workTask).set({ sessionId: runtime.sessionId }).where(eq(workTask.id, taskId));
      if (l.cancelled) {
        await runtime.stop();
        return;
      }
      await runtime.send(await this.promptWithHistory(taskId));
    } catch (e) {
      await this.fail(taskId, e instanceof Error ? e.message : "The agent couldn't start.");
    }
  }

  /**
   * The newest message, plus (when an earlier runtime worked on this task) the conversation so far,
   * so a restarted runtime knows what happened. The files are still in the folder.
   */
  private async promptWithHistory(taskId: string): Promise<string> {
    const events = await this.ctx.db
      .select({ kind: workEvent.kind, data: workEvent.data })
      .from(workEvent)
      .where(and(eq(workEvent.taskId, taskId), inArray(workEvent.kind, ["user", "assistant", "tool_call"])))
      .orderBy(asc(workEvent.seq));
    const lastUser = events.findLastIndex((e) => e.kind === "user");
    const prompt = String(events[lastUser]?.data.text ?? "");
    const earlier = events.slice(0, lastUser);
    if (!earlier.some((e) => e.kind === "assistant")) return prompt;
    const lines: string[] = [];
    for (const e of earlier) {
      if (e.kind === "user") lines.push(`User: ${e.data.text}`);
      else if (e.kind === "assistant" && e.data.text) lines.push(`You: ${e.data.text}`);
      else if (e.kind === "tool_call") lines.push(`(you used ${e.data.name}: ${clip(JSON.stringify(e.data.args ?? {}), 300)})`);
    }
    let history = lines.join("\n");
    if (history.length > SEED_CHARS) history = `…${history.slice(-SEED_CHARS)}`;
    return [
      "This task continues an earlier conversation. Files you created are still in your working folder.",
      "<earlier-conversation>",
      history,
      "</earlier-conversation>",
      "",
      prompt,
    ].join("\n");
  }

  private async onEvent(l: Live, e: HarnessEvent) {
    const { taskId } = l;
    switch (e.type) {
      case "assistant":
        if (!e.text && e.toolCalls.length === 0) return;
        if (e.text) l.lastAnswer = e.text;
        await this.record(taskId, "assistant", { text: e.text, toolCalls: e.toolCalls });
        return;
      case "tool_call":
        await this.record(taskId, "tool_call", { callId: e.callId, name: e.name, args: e.args as Record<string, unknown> });
        return;
      case "tool_result":
        await this.record(taskId, "tool_result", { callId: e.callId, text: clip(e.text, MAX_TOOL_TEXT), isError: e.isError });
        this.pulse(taskId, "files", {});
        return;
      case "plan":
        await this.record(taskId, "plan", { items: e.items });
        return;
      case "turn_end": {
        if (l.cancelled) return;
        l.busy = false;
        // completed, blocked (a person said no) and max-tokens all end with an answer to show.
        const ok = e.reason === "completed" || e.reason === "blocked" || e.reason === "max-tokens";
        const error = l.lastError ?? (ok ? null : (e.error ?? `The agent stopped (${e.reason}).`));
        await this.setStatus(taskId, error ? "failed" : "completed", { result: l.lastAnswer ? clip(l.lastAnswer, 4000) : null, error });
        await this.notifyDone(l, error);
        this.armIdle(l);
        await this.pump();
        return;
      }
      case "exit": {
        this.live.delete(taskId);
        this.byToken.delete(l.token);
        clearTimeout(l.idleTimer);
        if (l.cancelled || !l.busy || this.stopped) return;
        await this.fail(taskId, l.lastError ?? `The agent stopped unexpectedly.${e.error ? ` ${e.error.split("\n").at(-1)}` : ""}`);
        return;
      }
      default:
        return;
    }
  }

  private async fail(taskId: string, error: string) {
    const l = this.live.get(taskId);
    if (l) {
      l.busy = false;
      this.live.delete(taskId);
      this.byToken.delete(l.token);
      clearTimeout(l.idleTimer);
      if (l.runtime?.alive) void l.runtime.stop();
    }
    await this.expireApprovals(taskId);
    await this.setStatus(taskId, "failed", { error });
    if (l) await this.notifyDone(l, error);
    await this.pump();
  }

  private async notifyDone(l: Live, error: string | null) {
    const [t] = await this.ctx.db.select({ title: workTask.title }).from(workTask).where(eq(workTask.id, l.taskId));
    await this.ctx.db.insert(notification).values({
      userId: l.userId,
      type: error ? "work_failed" : "work_done",
      title: error ? `Task needs attention: ${t?.title ?? "task"}` : `Task finished: ${t?.title ?? "task"}`,
      body: error ?? (l.lastAnswer ? clip(l.lastAnswer, 200) : undefined),
      link: `/work/${l.taskId}`,
    });
  }

  private armIdle(l: Live) {
    clearTimeout(l.idleTimer);
    void getWorkSettings(this.ctx.db).then((s) => {
      if (l.busy || !this.live.has(l.taskId)) return;
      l.idleTimer = setTimeout(() => void this.release(l.taskId), s.idleMinutes * 60_000);
      l.idleTimer.unref();
    });
  }

  /** Stop a task's runtime (it can be restarted from history). */
  async release(taskId: string) {
    const l = this.live.get(taskId);
    if (!l) return;
    this.live.delete(taskId);
    this.byToken.delete(l.token);
    clearTimeout(l.idleTimer);
    l.busy = false;
    await l.runtime?.stop();
  }

  async cancel(taskId: string) {
    const l = this.live.get(taskId);
    if (l) l.cancelled = true;
    await this.release(taskId);
    await this.expireApprovals(taskId);
    const [t] = await this.ctx.db.select({ status: workTask.status }).from(workTask).where(eq(workTask.id, taskId));
    if (t && t.status !== "completed" && t.status !== "failed" && t.status !== "cancelled") await this.setStatus(taskId, "cancelled");
    await this.pump();
  }

  async remove(taskId: string) {
    await this.cancel(taskId);
    this.seqs.delete(taskId);
    await rm(this.taskDir(taskId), { recursive: true, force: true });
  }

  /** After a restart nothing is running: unfinished tasks fail visibly, queued ones start again. */
  async recover() {
    const stale = await this.ctx.db
      .select({ id: workTask.id })
      .from(workTask)
      .where(or(eq(workTask.status, "running"), eq(workTask.status, "needs_approval")));
    for (const t of stale) {
      await this.expireApprovals(t.id);
      await this.setStatus(t.id, "failed", { error: "The server restarted while this task was running. Send a message to continue." });
    }
    await this.pump();
  }

  async stopAll() {
    this.stopped = true;
    await Promise.all([...this.live.keys()].map((id) => this.release(id)));
  }

  isLive(taskId: string) {
    return this.live.get(taskId)?.runtime?.alive ?? false;
  }

  /* ───────────── Internal API support ───────────── */

  /** The task a runtime token belongs to (null when unknown or stopped). */
  fromToken(token: string): { taskId: string; userId: string; workspaceId: string } | null {
    const id = this.byToken.get(token);
    const l = id ? this.live.get(id) : undefined;
    return l && !l.cancelled ? { taskId: l.taskId, userId: l.userId, workspaceId: l.workspaceId } : null;
  }

  reportError(taskId: string, message: string) {
    const l = this.live.get(taskId);
    if (l) l.lastError = message;
  }

  async requestApproval(taskId: string, a: { callId: string | null; toolName: string; reason: string | null }) {
    const { db } = this.ctx;
    // The tool call itself may still be on its way to the timeline.
    await this.writes.get(taskId)?.catch(() => undefined);
    let detail: Record<string, unknown> | null = null;
    if (a.callId) {
      const calls = await db
        .select({ data: workEvent.data })
        .from(workEvent)
        .where(and(eq(workEvent.taskId, taskId), eq(workEvent.kind, "tool_call")))
        .orderBy(desc(workEvent.seq))
        .limit(20);
      detail = (calls.find((c) => c.data.callId === a.callId)?.data.args as Record<string, unknown> | undefined) ?? null;
    }
    const [row] = await db
      .insert(workApproval)
      .values({ taskId, callId: a.callId, toolName: a.toolName, reason: a.reason, detail })
      .returning();
    await this.setStatus(taskId, "needs_approval");
    await this.record(taskId, "approval", { id: row!.id, callId: a.callId, toolName: a.toolName, reason: a.reason, detail, status: "pending" });
    const l = this.live.get(taskId);
    const [t] = await db.select({ title: workTask.title }).from(workTask).where(eq(workTask.id, taskId));
    if (l) {
      await db.insert(notification).values({
        userId: l.userId,
        type: "work_approval",
        title: `Approval needed: ${t?.title ?? "task"}`,
        body: a.reason ?? `The agent wants to use ${a.toolName}.`,
        link: `/work/${taskId}`,
      });
    }
    return row!;
  }

  /** Wait up to `seconds` for a decision. */
  async waitForApproval(taskId: string, id: string, seconds: number) {
    const { db } = this.ctx;
    const read = async () => (await db.select().from(workApproval).where(and(eq(workApproval.id, id), eq(workApproval.taskId, taskId))))[0];
    let a = await read();
    if (!a) return null;
    if (a.status === "pending" && Date.now() - a.createdAt.getTime() > APPROVAL_TTL_MS) {
      await this.decide(a.id, "expired", null);
      return "expired" as const;
    }
    if (a.status === "pending" && seconds > 0) {
      await new Promise<void>((resolveWait) => {
        let set = this.approvalWaiters.get(id);
        if (!set) this.approvalWaiters.set(id, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          set!.delete(done);
          resolveWait();
        };
        const timer = setTimeout(done, seconds * 1000);
        set.add(done);
      });
      a = await read();
    }
    return a?.status ?? null;
  }

  async decide(approvalId: string, status: "approved" | "rejected" | "expired", userId: string | null) {
    const { db } = this.ctx;
    const [a] = await db
      .update(workApproval)
      .set({ status, decidedBy: userId, decidedAt: new Date() })
      .where(and(eq(workApproval.id, approvalId), eq(workApproval.status, "pending")))
      .returning();
    if (!a) return null;
    for (const w of [...(this.approvalWaiters.get(approvalId) ?? [])]) w();
    this.approvalWaiters.delete(approvalId);
    await this.record(a.taskId, "approval", { id: a.id, callId: a.callId, toolName: a.toolName, reason: a.reason, detail: a.detail, status });
    const pending = await db
      .select({ id: workApproval.id })
      .from(workApproval)
      .where(and(eq(workApproval.taskId, a.taskId), eq(workApproval.status, "pending")));
    const l = this.live.get(a.taskId);
    if (pending.length === 0 && l?.busy && !l.cancelled) await this.setStatus(a.taskId, "running");
    return a;
  }

  private async expireApprovals(taskId: string) {
    const pending = await this.ctx.db
      .select({ id: workApproval.id })
      .from(workApproval)
      .where(and(eq(workApproval.taskId, taskId), eq(workApproval.status, "pending")));
    for (const p of pending) await this.decide(p.id, "expired", null);
  }

  /* ───────────── Task setup ───────────── */

  /** Org skills plus the person's own, as SKILL.md folders the runtime discovers. */
  private async writeSkills(userId: string, dir: string): Promise<string | null> {
    const rows = await this.ctx.db
      .select()
      .from(skill)
      .where(and(eq(skill.enabled, true), or(eq(skill.scope, "org"), and(eq(skill.scope, "personal"), eq(skill.ownerId, userId)))));
    await rm(dir, { recursive: true, force: true });
    if (rows.length === 0) return null;
    const used = new Set<string>();
    for (const s of rows) {
      let slug = slugify(s.slug || s.name);
      while (used.has(slug)) slug = `${slug}-${used.size}`;
      used.add(slug);
      await mkdir(join(dir, slug), { recursive: true });
      const front = ["---", `name: ${slug}`, `description: ${JSON.stringify(s.description.replace(/\s+/g, " "))}`, "---", ""].join("\n");
      await writeFile(join(dir, slug, "SKILL.md"), `${front}# ${s.name}\n\n${s.body}\n`);
    }
    return dir;
  }

  private async connectorSpecs() {
    const rows = await this.ctx.db.select().from(connector).where(eq(connector.enabled, true));
    return rows.map((c) => ({
      name: c.name,
      url: c.url,
      headers: c.headersEnc ? (JSON.parse(this.ctx.box.decrypt(c.headersEnc)) as Record<string, string>) : undefined,
      approveTools: c.approveTools
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    }));
  }
}
