import {
  and,
  eq,
  gte,
  isNull,
  organization,
  sql,
  tokenRequest,
  usageEvent,
  userGroup,
  userGroupMember,
  workspace,
  workspaceMember,
  type DB,
} from "@aatmiq/db";
import type { AvailableModel } from "./models";
import {
  defaultUserQuota,
  evaluateQuota,
  periodEnd,
  periodStart,
  type BudgetPeriod,
  type QuotaResult,
} from "@aatmiq/shared";

export interface QuotaStatus {
  /** Whose budget this is: the workspace's, or a group's (for a model only that group gives). */
  scope: { kind: "workspace" } | { kind: "group"; id: string; name: string };
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
      // Calls a group paid for don't count against the workspace.
      .where(and(eq(usageEvent.workspaceId, workspaceId), isNull(usageEvent.groupId), gte(usageEvent.createdAt, start))),
    db
      .select({ n: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint` })
      .from(usageEvent)
      .where(
        and(eq(usageEvent.workspaceId, workspaceId), eq(usageEvent.userId, userId), isNull(usageEvent.groupId), gte(usageEvent.createdAt, start)),
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
    scope: { kind: "workspace" },
    period,
    periodStart: start.toISOString(),
    resetsAt: periodEnd(period, now).toISOString(),
    user: { limit: userLimit, bonus: userBonus, used: input.userUsed, isOverride: override !== null },
    workspace: { limit: wsLimit, bonus: wsBonus, used: input.workspaceUsed },
    result: evaluateQuota(input),
  };
}

/**
 * A person's position in a group's budget, across all workspaces. Same rules as a workspace: the
 * group budget split evenly among members unless the group sets a per-person amount. `workspace`
 * holds the group's totals so the shape matches; token requests are workspace-only.
 */
export async function getGroupQuotaStatus(db: DB, groupId: string, userId: string, now = new Date()): Promise<QuotaStatus> {
  const period = await getOrgPeriod(db);
  const start = periodStart(period, now);
  const sum = sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint`;
  const [[g], [members], [poolUsed], [userUsed]] = await Promise.all([
    db.select().from(userGroup).where(eq(userGroup.id, groupId)),
    db.select({ n: sql<number>`count(*)::int` }).from(userGroupMember).where(eq(userGroupMember.groupId, groupId)),
    db.select({ n: sum }).from(usageEvent).where(and(eq(usageEvent.groupId, groupId), gte(usageEvent.createdAt, start))),
    db.select({ n: sum }).from(usageEvent).where(and(eq(usageEvent.groupId, groupId), eq(usageEvent.userId, userId), gte(usageEvent.createdAt, start))),
  ]);
  const poolLimit = g?.tokenLimit ?? null;
  const userLimit = g?.memberTokenLimit ?? defaultUserQuota(poolLimit, members?.n ?? 1);
  const input = { userLimit, userBonus: 0, userUsed: Number(userUsed?.n ?? 0), workspaceLimit: poolLimit, workspaceBonus: 0, workspaceUsed: Number(poolUsed?.n ?? 0) };
  const result = evaluateQuota(input);
  return {
    scope: { kind: "group", id: groupId, name: g?.name ?? "" },
    period,
    periodStart: start.toISOString(),
    resetsAt: periodEnd(period, now).toISOString(),
    user: { limit: userLimit, bonus: 0, used: input.userUsed, isOverride: g?.memberTokenLimit != null },
    workspace: { limit: poolLimit, bonus: 0, used: input.workspaceUsed },
    result: { ...result, blockedBy: result.blockedBy === "workspace" ? "group" : result.blockedBy },
  };
}

/**
 * Who pays for a call to this model, and whether there's budget left: the workspace for its own
 * models; for a model only groups give, the granting group with the most left (unlimited first).
 */
export async function quotaFor(db: DB, workspaceId: string, userId: string, m: Pick<AvailableModel, "groups"> | null): Promise<{ status: QuotaStatus; groupId: string | null }> {
  if (!m?.groups.length) return { status: await getQuotaStatus(db, workspaceId, userId), groupId: null };
  const all = await Promise.all(m.groups.map((g) => getGroupQuotaStatus(db, g.id, userId)));
  const rank = (q: QuotaStatus) => (!q.result.allowed ? -1 : q.result.remaining === null ? Infinity : q.result.remaining);
  const best = all.reduce((a, b) => (rank(b) > rank(a) ? b : a));
  return { status: best, groupId: best.scope.kind === "group" ? best.scope.id : null };
}
