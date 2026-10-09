/**
 * How the installation is doing (Admin → Health), and alerts to the organization's admins when
 * something breaks: in Aatmiq and by email, once when it starts, a reminder every day while it
 * lasts, and once when it's fixed.
 *
 * Checks: the database, disk space, each model server, Work AI's queue, background jobs, backups
 * (deploy/backup/backup.sh records each run), the network fence for tasks and IDEs, the license
 * and email.
 */
import { and, document, eq, inArray, lt, model, modelProvider, sql, systemStatus, user, workApproval, workTask, type DB } from "@aatmiq/db";
import { testProvider } from "@aatmiq/model-gateway";
import { statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { getOrg, notify, type AppContext } from "../context";
import { getWorkSettings } from "./work";

export type Level = "ok" | "warn" | "error";

export interface Check {
  /** Stable id: alerts remember which problems admins were told about by it. */
  id: string;
  area: "Database" | "Disk" | "Models" | "Work AI" | "Background jobs" | "Backups" | "Security" | "License" | "Email";
  level: Level;
  summary: string;
  /** What to do about it. */
  hint?: string;
  /** Problems worth telling admins about (not, say, email being off, which they set up once). */
  alert: boolean;
}

export interface HealthReport {
  checkedAt: string;
  level: Level;
  checks: Check[];
}

const GiB = 1024 ** 3;
const RANK: Record<Level, number> = { ok: 0, warn: 1, error: 2 };
const DAY_MS = 86_400_000;
/** A backup older than this is overdue (they run nightly). */
const BACKUP_STALE_MS = 36 * 3_600_000;
/** Tasks waiting this long for a free slot means the organization's limit or the model is too slow. */
const QUEUE_SLOW_MS = 15 * 60_000;
/** A document still "processing" after this long is stuck. */
const DOCUMENT_STUCK_MS = 30 * 60_000;

export const worst = (levels: Level[]): Level => levels.reduce<Level>((a, b) => (RANK[b] > RANK[a] ? b : a), "ok");

/** Free space: under 2 GB or 5% is an error, under 10 GB or 15% a warning. */
export function diskLevel(free: number, total: number): Level {
  const share = total > 0 ? free / total : 0;
  if (free < 2 * GiB || share < 0.05) return "error";
  if (free < 10 * GiB || share < 0.15) return "warn";
  return "ok";
}

export function bytes(n: number): string {
  if (n >= 1024 ** 4) return `${(n / 1024 ** 4).toFixed(1)} TB`;
  if (n >= GiB) return `${(n / GiB).toFixed(n >= 100 * GiB ? 0 : 1)} GB`;
  if (n >= 1024 ** 2) return `${Math.round(n / 1024 ** 2)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

const ago = (ms: number) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min` : ms < 2 * DAY_MS ? `${Math.round(ms / 3_600_000)} h` : `${Math.round(ms / DAY_MS)} days`);

export async function readStatus<T extends Record<string, unknown>>(db: DB, key: string): Promise<{ value: T; updatedAt: Date } | null> {
  const [row] = await db.select().from(systemStatus).where(eq(systemStatus.key, key));
  return row ? { value: row.value as T, updatedAt: row.updatedAt } : null;
}

export async function writeStatus(db: DB, key: string, value: Record<string, unknown>) {
  await db
    .insert(systemStatus)
    .values({ key, value })
    .onConflictDoUpdate({ target: systemStatus.key, set: { value, updatedAt: new Date() } });
}

/* ───────────── The checks ───────────── */

async function databaseCheck(db: DB): Promise<Check> {
  const started = Date.now();
  try {
    const rows = (await db.execute(sql`select pg_database_size(current_database())::bigint as size`)) as unknown as { size: string }[];
    return { id: "database", area: "Database", level: "ok", summary: `Connected (${Date.now() - started} ms), ${bytes(Number(rows[0]?.size ?? 0))} of data.`, alert: true };
  } catch (e) {
    return { id: "database", area: "Database", level: "error", summary: `Can't reach the database: ${(e as Error).message}`, alert: true };
  }
}

/** One check per filesystem that holds Aatmiq's data. */
async function diskChecks(ctx: AppContext): Promise<Check[]> {
  const folders: [string, string | undefined | null][] = [
    ["uploads", ctx.cfg.s3 ? null : ctx.cfg.storageDir],
    ["Work AI task folders", ctx.cfg.workDir],
    ["Code homes", ctx.cfg.codeDir],
  ];
  const disks = new Map<string, { free: number; total: number; what: string[] }>();
  for (const [what, dir] of folders) {
    if (!dir) continue;
    const s = await statfs(resolve(dir)).catch(() => null);
    if (!s) continue;
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    // Folders on the same filesystem report the same size; count it once.
    const key = `${s.type}:${s.blocks}:${s.bsize}`;
    const d = disks.get(key) ?? { free, total, what: [] };
    d.what.push(what);
    disks.set(key, d);
  }
  return [...disks.values()].map((d) => {
    const level = diskLevel(d.free, d.total);
    return {
      id: `disk:${d.what[0]}`,
      area: "Disk",
      level,
      summary: `${bytes(d.free)} free of ${bytes(d.total)} (${Math.round((d.free / d.total) * 100)}%) for ${d.what.join(", ")}.`,
      ...(level !== "ok" ? { hint: "Delete old Work AI tasks and documents, move backups to another disk, or add space. Below 2 GB uploads and tasks start failing." } : {}),
      alert: true,
    } satisfies Check;
  });
}

/** Each model server that has models, asked for its model list (as Admin → Models → Test does). */
async function modelChecks(ctx: AppContext): Promise<Check[]> {
  const { db, box } = ctx;
  const providers = await db
    .select()
    .from(modelProvider)
    .where(sql`${modelProvider.type} <> 'mock' and exists (select 1 from ${model} where ${model.providerId} = ${modelProvider.id})`);
  if (providers.length === 0) {
    const demo = await db.select({ id: modelProvider.id }).from(modelProvider).limit(1);
    return [
      {
        id: "models",
        area: "Models",
        level: "warn",
        summary: demo.length ? "Only the built-in demo model is connected: it can't really answer." : "No model server is connected.",
        hint: "Connect your model server (vLLM, Ollama or an OpenAI-compatible service) in Admin → Models.",
        alert: false,
      },
    ];
  }
  return Promise.all(
    providers.map(async (p): Promise<Check> => {
      const health = await testProvider({ id: p.id, type: p.type, baseUrl: p.baseUrl, apiKey: p.apiKeyEnc ? box.decrypt(p.apiKeyEnc) : null });
      await db
        .update(modelProvider)
        .set({ health: { ok: health.ok, latencyMs: health.latencyMs, error: health.error, checkedAt: new Date().toISOString() } })
        .where(eq(modelProvider.id, p.id));
      return health.ok
        ? { id: `model:${p.id}`, area: "Models", level: "ok", summary: `${p.name}: answering (${health.latencyMs} ms).`, alert: true }
        : {
            id: `model:${p.id}`,
            area: "Models",
            level: "error",
            summary: `${p.name} isn't answering: ${health.error ?? "no reply"}`,
            hint: "Chat, Work AI and document search that use it fail until it's back. Check the model server (on the team server: deploy/team.sh ps and logs).",
            alert: true,
          };
    }),
  );
}

async function workCheck(ctx: AppContext): Promise<Check> {
  const { db } = ctx;
  const settings = await getWorkSettings(db);
  const [queued] = await db
    .select({ n: sql<number>`count(*)::int`, oldest: sql<string | null>`min(${workTask.createdAt})` })
    .from(workTask)
    .where(eq(workTask.status, "queued"));
  const [asking] = await db.select({ n: sql<number>`count(*)::int` }).from(workApproval).where(eq(workApproval.status, "pending"));
  const working = ctx.work.working();
  const waitedMs = queued?.oldest ? Date.now() - new Date(queued.oldest).getTime() : 0;
  const summary = `${working} of ${settings.maxRunning} task${settings.maxRunning === 1 ? "" : "s"} working, ${queued?.n ?? 0} waiting for a slot, ${asking?.n ?? 0} waiting for someone's approval.`;
  if (waitedMs > QUEUE_SLOW_MS)
    return {
      id: "work:queue",
      area: "Work AI",
      level: "warn",
      summary: `${summary} The oldest has waited ${ago(waitedMs)}.`,
      hint: "Tasks are waiting long for a free slot: check the model server's speed, or raise Tasks working at once in Admin → Work AI if the GPU has room.",
      alert: true,
    };
  return { id: "work:queue", area: "Work AI", level: "ok", summary, alert: true };
}

async function jobsCheck(ctx: AppContext): Promise<Check> {
  const s = await ctx.jobs.status();
  const [stuck] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(document)
    .where(and(eq(document.status, "processing"), lt(document.updatedAt, new Date(Date.now() - DOCUMENT_STUCK_MS))));
  const where = s.mode === "in-process" ? "inside the API" : `in ${s.workers.length} worker${s.workers.length === 1 ? "" : "s"}`;
  if (s.mode !== "in-process" && s.workers.length === 0)
    return { id: "jobs", area: "Background jobs", level: "error", summary: "No background worker is running: uploaded documents aren't being read.", hint: "Start the worker service (docker compose … --profile worker up -d).", alert: true };
  if ((stuck?.n ?? 0) > 0)
    return { id: "jobs", area: "Background jobs", level: "warn", summary: `${stuck!.n} document${stuck!.n === 1 ? " has" : "s have"} been processing for over 30 minutes.`, hint: "Reprocess them from Documents; if it keeps happening, check the API's logs.", alert: true };
  if (s.counts.failed > 0)
    return { id: "jobs", area: "Background jobs", level: "warn", summary: `Running ${where}; ${s.counts.failed} job${s.counts.failed === 1 ? "" : "s"} failed.`, hint: "Admin → Overview lists them.", alert: true };
  return { id: "jobs", area: "Background jobs", level: "ok", summary: `Running ${where}; ${s.counts.waiting} waiting.`, alert: true };
}

async function backupCheck(ctx: AppContext): Promise<Check> {
  const b = await readStatus<{ ok?: boolean; name?: string; bytes?: number; at?: string; lastOk?: string | null }>(ctx.db, "backup");
  if (!b)
    return {
      id: "backup",
      area: "Backups",
      level: "warn",
      summary: "No backup has been recorded.",
      hint: "Nightly backups run with deploy/docker-compose.backup.yml (deploy/team.sh includes it). Make one now: deploy/team.sh exec backup /scripts/backup.sh",
      alert: false,
    };
  const at = b.value.at ? new Date(b.value.at) : b.updatedAt;
  if (b.value.ok === false)
    return {
      id: "backup",
      area: "Backups",
      level: "error",
      summary: `The last backup failed (${ago(Date.now() - at.getTime())} ago).${b.value.lastOk ? ` The last good one is ${ago(Date.now() - new Date(b.value.lastOk).getTime())} old.` : ""}`,
      hint: "See the backup service's log (deploy/team.sh logs backup): often the backup disk is full or not mounted.",
      alert: true,
    };
  const age = Date.now() - at.getTime();
  if (age > BACKUP_STALE_MS)
    return { id: "backup", area: "Backups", level: "warn", summary: `The last backup is ${ago(age)} old.`, hint: "Backups run every night: check that the backup service is running (deploy/team.sh ps).", alert: true };
  return { id: "backup", area: "Backups", level: "ok", summary: `Last backup ${b.value.name ?? ""} ${ago(age)} ago${b.value.bytes ? ` (${bytes(b.value.bytes)})` : ""}.`, alert: true };
}

function securityCheck(ctx: AppContext): Check {
  const ownUsers = process.getuid?.() === 0 && ctx.cfg.workIsolation !== "off";
  const containers = ctx.cfg.workIsolation === "container";
  if (!ownUsers)
    return {
      id: "security:isolation",
      area: "Security",
      level: "warn",
      summary: "Work AI tasks and IDEs run as the API's own user, so they could read each other's files.",
      hint: "Run the API as root, as the Docker image does (each task and IDE then gets its own Unix user).",
      alert: false,
    };
  const fw = process.env.AATMIQ_USER_FIREWALL;
  if (fw !== "on")
    return {
      id: "security:firewall",
      area: "Security",
      level: "warn",
      summary: `${containers ? "IDE terminals" : "Work AI tasks and IDE terminals"} can reach private networks (the database, model servers, your office network): the user firewall is ${fw === "failed" ? "failing" : "off"}.`,
      hint: "Give the API container the NET_ADMIN capability (deploy/docker-compose.yml does). See docs/10-team-server.md#security.",
      alert: true,
    };
  return {
    id: "security:firewall",
    area: "Security",
    level: "ok",
    summary: `${containers ? "Work AI tasks run in their own containers. " : ""}Tasks and IDEs each run as their own user and can't reach private networks.`,
    alert: true,
  };
}

async function licenseCheck(ctx: AppContext): Promise<Check> {
  const { status } = await ctx.license.info();
  const days = status.daysLeft;
  const base = { id: "license", area: "License" as const, alert: true };
  switch (status.state) {
    case "valid":
      return days !== null && days <= 14
        ? { ...base, level: "warn", summary: `The license ends in ${days} day${days === 1 ? "" : "s"}.`, hint: "Renew it and enter the new key in Admin → License." }
        : { ...base, level: "ok", summary: days !== null ? `Valid, ${days} days left.` : "Valid." };
    case "development":
      return { ...base, level: "warn", summary: "Development mode: no license is set up.", hint: "Set LICENSE_PUBLIC_KEY and enter your license in Admin → License.", alert: false };
    case "check_in_overdue":
    case "expiring_grace":
      return { ...base, level: "warn", summary: status.message ?? "The license needs attention.", hint: "Admin → License." };
    default:
      return { ...base, level: "error", summary: status.message ?? `License: ${status.state}.`, hint: "Admin → License." };
  }
}

async function emailCheck(ctx: AppContext): Promise<Check> {
  return (await ctx.mail.configured())
    ? { id: "email", area: "Email", level: "ok", summary: "Set up: invitations, password resets and these alerts can be emailed.", alert: false }
    : {
        id: "email",
        area: "Email",
        level: "warn",
        summary: "Not set up: invitations, password resets and health alerts can't be emailed.",
        hint: "Admin → Settings → Email (or SMTP_URL in deploy/.env).",
        alert: false,
      };
}

export async function runChecks(ctx: AppContext): Promise<HealthReport> {
  const db = await databaseCheck(ctx.db);
  const rest =
    db.level === "error"
      ? []
      : (
          await Promise.all([
            diskChecks(ctx),
            modelChecks(ctx),
            workCheck(ctx).then((c) => [c]),
            jobsCheck(ctx).then((c) => [c]),
            backupCheck(ctx).then((c) => [c]),
            Promise.resolve([securityCheck(ctx)]),
            licenseCheck(ctx).then((c) => [c]),
            emailCheck(ctx).then((c) => [c]),
          ])
        ).flat();
  const checks = [db, ...rest];
  return { checkedAt: new Date().toISOString(), level: worst(checks.map((c) => c.level)), checks };
}

/* ───────────── Alerts ───────────── */

type AlertState = Record<string, { level: Level; since: number; notifiedAt: number }>;
export type HealthSettings = { email: boolean };

export async function healthSettings(db: DB): Promise<HealthSettings> {
  const s = await readStatus<Partial<HealthSettings>>(db, "health_settings");
  return { email: s?.value.email !== false };
}

export class HealthMonitor {
  private timer?: NodeJS.Timeout;
  constructor(
    private ctx: AppContext,
    private opts: { intervalMs: number; log: (msg: string, err?: unknown) => void },
  ) {}

  start() {
    this.timer = setInterval(() => void this.tick().catch((e) => this.opts.log("health check failed", e)), this.opts.intervalMs);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** One round: check, then tell admins what started, still lasts (daily) or got fixed. */
  async tick(opts: { force?: boolean } = {}): Promise<{ report: HealthReport; told: { id: string; kind: "problem" | "reminder" | "resolved" }[] } | null> {
    const { db } = this.ctx;
    // With several API copies, one of them runs each round.
    if (!opts.force) {
      await db.insert(systemStatus).values({ key: "health_run", value: {}, updatedAt: new Date(0) }).onConflictDoNothing();
      const claimed = await db
        .update(systemStatus)
        .set({ value: { at: new Date().toISOString() }, updatedAt: new Date() })
        .where(and(eq(systemStatus.key, "health_run"), lt(systemStatus.updatedAt, new Date(Date.now() - this.opts.intervalMs * 0.8))))
        .returning({ key: systemStatus.key });
      if (claimed.length === 0) return null;
    }
    const report = await runChecks(this.ctx);
    const state = (await readStatus<AlertState>(db, "health_alerts"))?.value ?? {};
    const now = Date.now();
    const told: { check: Check; kind: "problem" | "reminder" | "resolved" }[] = [];
    for (const c of report.checks) {
      const prev = state[c.id];
      if (c.level === "ok" || !c.alert) {
        if (prev) {
          if (c.level === "ok") told.push({ check: c, kind: "resolved" });
          delete state[c.id];
        }
        continue;
      }
      if (!prev || RANK[c.level] > RANK[prev.level]) {
        state[c.id] = { level: c.level, since: prev?.since ?? now, notifiedAt: now };
        told.push({ check: c, kind: "problem" });
      } else if (now - prev.notifiedAt >= DAY_MS) {
        state[c.id] = { ...prev, level: c.level, notifiedAt: now };
        told.push({ check: c, kind: "reminder" });
      } else state[c.id] = { ...prev, level: c.level };
    }
    // A check that's gone (a model server removed) has nothing left to report.
    for (const id of Object.keys(state)) if (!report.checks.some((c) => c.id === id)) delete state[id];
    await writeStatus(db, "health_alerts", state);
    if (told.length) await this.tell(told);
    return { report, told: told.map((t) => ({ id: t.check.id, kind: t.kind })) };
  }

  /** In Aatmiq for every admin, and one email each when email is set up and alerts are on. */
  async tell(items: { check: Check; kind: "problem" | "reminder" | "resolved" }[], only?: string[]) {
    const { db, cfg } = this.ctx;
    const admins = await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(and(inArray(user.orgRole, ["owner", "admin"]), eq(user.status, "active"), ...(only ? [inArray(user.id, only)] : [])));
    if (admins.length === 0) return;
    const product = (await getOrg(db))?.productName ?? "Aatmiq";
    const problems = items.filter((i) => i.kind !== "resolved");
    const fixed = items.filter((i) => i.kind === "resolved");
    const title = problems.length
      ? `${problems.length === 1 ? `${problems[0]!.check.area}: ` : `${problems.length} problems: `}${problems.length === 1 ? problems[0]!.check.summary : problems.map((p) => p.check.area).join(", ")}`
      : `Fixed: ${fixed.map((f) => f.check.area).join(", ")}`;
    const line = (i: { check: Check; kind: string }) =>
      `${i.kind === "resolved" ? "Fixed" : i.check.level === "error" ? "Problem" : "Warning"}${i.kind === "reminder" ? " (still)" : ""} · ${i.check.area}: ${i.check.summary}${i.kind !== "resolved" && i.check.hint ? ` ${i.check.hint}` : ""}`;
    await notify(
      db,
      admins.map((a) => a.id),
      { type: "health", title: title.slice(0, 200), body: items.map(line).join("\n").slice(0, 2000), link: "/admin/health" },
    );
    if (!(await healthSettings(db)).email || !(await this.ctx.mail.configured())) return;
    const subject = problems.length ? `${product}: ${problems.length === 1 ? "a problem needs" : `${problems.length} problems need`} attention` : `${product}: fixed`;
    for (const a of admins) {
      await this.ctx.mail
        .send({ to: a.email, subject, lines: [problems.length ? `${product} found ${problems.length === 1 ? "a problem" : "problems"} on your server.` : "These are working again:", ...items.map(line)], button: { label: "Open Health", url: `${cfg.appUrl}/admin/health` } })
        .catch((e) => this.opts.log("health alert email failed", e));
    }
  }
}
