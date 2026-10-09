/**
 * Scheduled Work AI tasks: every half minute, due schedules start a new task.
 * A schedule is claimed by moving its next run forward first, so two API instances never both run it.
 */
import { and, eq, lte, workSchedule, workTask, type DB } from "@aatmiq/db";
import { CronExpressionParser } from "cron-parser";
import type { AppContext } from "../context";
import { badRequest } from "../errors";
import { getMembership } from "../context";
import type { Routing } from "@aatmiq/shared";
import { availableModels } from "./models";
import { chooseModel } from "./router";

/** Next run after `from`, or a readable error for a bad expression or time zone. */
export function nextRun(cron: string, timezone: string, from = new Date()): Date {
  try {
    return CronExpressionParser.parse(cron, { tz: timezone, currentDate: from }).next().toDate();
  } catch (e) {
    throw badRequest(`That schedule isn't valid: ${e instanceof Error ? e.message : "check the fields"}`);
  }
}

/** Refuses schedules more often than every 5 minutes (each run is a full agent task). */
export function assertReasonable(cron: string, timezone: string) {
  const a = nextRun(cron, timezone);
  const b = nextRun(cron, timezone, a);
  const c = nextRun(cron, timezone, b);
  if (Math.min(b.getTime() - a.getTime(), c.getTime() - b.getTime()) < 5 * 60_000) throw badRequest("Schedules can run at most every 5 minutes.");
}

export async function runSchedule(ctx: AppContext, s: typeof workSchedule.$inferSelect) {
  const { db } = ctx;
  const m = await getMembership(db, s.workspaceId, s.userId);
  if (!(await ctx.license.hasSection("work"))) return null;
  // The person may have left the workspace (org admins aren't members but may use it).
  const models = await availableModels(db, s.workspaceId, "work", s.userId);
  let model = models.find((x) => x.id === s.modelId) ?? models.find((x) => x.isDefault) ?? models[0];
  let routing: Routing | null = null;
  // Without a model of its own, the default applies, and that may be Auto.
  if (models.length && !models.some((x) => x.id === s.modelId)) {
    const chosen = await chooseModel(db, ctx.box, { workspaceId: s.workspaceId, section: "work", userId: s.userId, requested: null, text: s.prompt, hasSources: Boolean(s.projectId) }).catch(() => null);
    if (chosen) ({ model, routing } = chosen);
  }
  const [t] = await db
    .insert(workTask)
    .values({ workspaceId: s.workspaceId, userId: s.userId, title: s.name, modelId: model?.id ?? null, routing, scheduleId: s.id, projectId: s.projectId })
    .returning();
  await db.update(workSchedule).set({ lastRunAt: new Date(), lastTaskId: t!.id }).where(eq(workSchedule.id, s.id));
  if (!model || (m && !m.sections.includes("work") && m.role !== "admin")) {
    await db.update(workTask).set({ status: "failed", error: model ? "Work AI is no longer enabled for you in this workspace." : "No model is available for Work AI in this workspace.", finishedAt: new Date() }).where(eq(workTask.id, t!.id));
    return t!;
  }
  await ctx.work.submit(t!.id, s.prompt);
  return t!;
}

export async function runDueSchedules(ctx: AppContext, now = new Date()) {
  const { db } = ctx;
  const due = await db
    .select()
    .from(workSchedule)
    .where(and(eq(workSchedule.enabled, true), lte(workSchedule.nextRunAt, now)));
  for (const s of due) {
    let next: Date | null = null;
    try {
      next = nextRun(s.cron, s.timezone, now);
    } catch {
      next = null;
    }
    const [claimed] = await db
      .update(workSchedule)
      .set({ nextRunAt: next, ...(next ? {} : { enabled: false }) })
      .where(and(eq(workSchedule.id, s.id), eq(workSchedule.nextRunAt, s.nextRunAt!)))
      .returning({ id: workSchedule.id });
    if (claimed && next) await runSchedule(ctx, s);
  }
}

export function startScheduler(ctx: AppContext, log: (msg: string, err?: unknown) => void) {
  const tick = () => void runDueSchedules(ctx).catch((e) => log("running schedules failed", e));
  const timer = setInterval(tick, 30_000);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}
