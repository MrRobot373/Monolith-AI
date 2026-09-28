import {
  and,
  eq,
  gte,
  organization,
  sql,
  tokenRequest,
  usageEvent,
  workspace,
  workspaceMember,
  type DB,
} from "@aatmiq/db";
import {
  defaultUserQuota,
  evaluateQuota,
  periodEnd,
  periodStart,
  type BudgetPeriod,
  type QuotaResult,
} from "@aatmiq/shared";

export interface QuotaStatus {
  period: BudgetPeriod;
  periodStart: string;
  resetsAt: string;
  user: { limit: number | null; bonus: number; used: number; isOverride: boolean };
  workspace: { limit: number | null; bonus: number; used: number };
  result: QuotaResult;
}

export async function getOrgPeriod(db: DB): Promise<BudgetPeriod> {
  const [org] = await db.select({ p: organization.budgetPeriod }).from(organization).limit(1);
  return org?.p ?? "month";
}

/** Current quota position for a user in a workspace (docs/01-foundation.md §6). */
export async function getQuotaStatus(
  db: DB,
  workspaceId: string,
  userId: string,
  now = new Date(),
): Promise<QuotaStatus> {
  const period = await getOrgPeriod(db);
  const start = periodStart(period, now);

  const [[ws], [member], [memberCount], [wsUsed], [userUsed], bonuses] = await Promise.all([
    db.select({ limit: workspace.tokenLimit }).from(workspace).where(eq(workspace.id, workspaceId)),
    db
      .select({ limit: workspaceMember.tokenLimit })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId))),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(workspaceMember)
      .where(eq(workspaceMember.workspaceId, workspaceId)),
    db
      .select({ n: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint` })
      .from(usageEvent)
      .where(and(eq(usageEvent.workspaceId, workspaceId), gte(usageEvent.createdAt, start))),
    db
      .select({ n: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint` })
      .from(usageEvent)
      .where(
        and(eq(usageEvent.workspaceId, workspaceId), eq(usageEvent.userId, userId), gte(usageEvent.createdAt, start)),
      ),
    db
      .select({ userId: tokenRequest.userId, amount: tokenRequest.decidedAmount, duration: tokenRequest.duration })
      .from(tokenRequest)
      .where(
        and(
          eq(tokenRequest.workspaceId, workspaceId),
          eq(tokenRequest.status, "approved"),
          eq(tokenRequest.periodStart, start),
        ),
      ),
  ]);

  const wsLimit = ws?.limit ?? null;
  const override = member?.limit ?? null;
  const userLimit = override ?? defaultUserQuota(wsLimit, memberCount?.n ?? 1);
  // Every approval raises the workspace's ceiling for the period it was approved in, so it
  // unblocks the person even when the workspace budget itself is used up. "period" approvals
  // also raise the user's ceiling for that period; "permanent" ones already raised their limit.
  const wsBonus = bonuses.reduce((s, b) => s + (b.amount ?? 0), 0);
  const userBonus = bonuses
    .filter((b) => b.userId === userId && b.duration === "period")
    .reduce((s, b) => s + (b.amount ?? 0), 0);

  const input = {
    userLimit,
    userBonus,
    userUsed: Number(userUsed?.n ?? 0),
    workspaceLimit: wsLimit,
    workspaceBonus: wsBonus,
    workspaceUsed: Number(wsUsed?.n ?? 0),
  };
  return {
    period,
    periodStart: start.toISOString(),
    resetsAt: periodEnd(period, now).toISOString(),
    user: { limit: userLimit, bonus: userBonus, used: input.userUsed, isOverride: override !== null },
    workspace: { limit: wsLimit, bonus: wsBonus, used: input.workspaceUsed },
    result: evaluateQuota(input),
  };
}
