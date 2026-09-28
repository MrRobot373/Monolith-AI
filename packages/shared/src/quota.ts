import type { BudgetPeriod } from "./schemas";

/** Start of the current budget period, in UTC. Weeks start on Monday. */
export function periodStart(period: BudgetPeriod, now: Date = new Date()): Date {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "day") return d;
  if (period === "week") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    d.setUTCDate(d.getUTCDate() - dow);
    return d;
  }
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Start of the next period (exclusive end of the current one). */
export function periodEnd(period: BudgetPeriod, now: Date = new Date()): Date {
  const s = periodStart(period, now);
  if (period === "day") return new Date(s.getTime() + 86_400_000);
  if (period === "week") return new Date(s.getTime() + 7 * 86_400_000);
  return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 1));
}

/**
 * Default per-user quota = workspace budget split evenly among members (D19).
 * Returns null (unlimited) when the workspace has no budget.
 */
export function defaultUserQuota(workspaceLimit: number | null, memberCount: number): number | null {
  if (workspaceLimit === null) return null;
  return Math.floor(workspaceLimit / Math.max(1, memberCount));
}

export interface QuotaInput {
  /** Effective user limit for the period (override or default); null = unlimited. */
  userLimit: number | null;
  /** Extra tokens approved via token requests for this period. */
  userBonus: number;
  userUsed: number;
  workspaceLimit: number | null;
  workspaceBonus: number;
  workspaceUsed: number;
}

export type QuotaBlocker = "user" | "workspace" | null;

export interface QuotaResult {
  allowed: boolean;
  blockedBy: QuotaBlocker;
  /** Remaining tokens at the most restrictive level; null = unlimited. */
  remaining: number | null;
  /** Fraction used at the most restrictive level (0..1+), null when unlimited. */
  usedFraction: number | null;
  /** Soft warning level (D13/§6.1): 0.8 and 0.95. */
  warning: null | "80" | "95";
}

/** A request is allowed only if every level has room. The most restrictive level wins. */
export function evaluateQuota(q: QuotaInput): QuotaResult {
  const levels: { name: Exclude<QuotaBlocker, null>; limit: number; used: number }[] = [];
  if (q.userLimit !== null) levels.push({ name: "user", limit: q.userLimit + q.userBonus, used: q.userUsed });
  if (q.workspaceLimit !== null)
    levels.push({ name: "workspace", limit: q.workspaceLimit + q.workspaceBonus, used: q.workspaceUsed });

  if (levels.length === 0)
    return { allowed: true, blockedBy: null, remaining: null, usedFraction: null, warning: null };

  let tightest = levels[0]!;
  for (const l of levels) if (l.limit - l.used < tightest.limit - tightest.used) tightest = l;

  const remaining = Math.max(0, tightest.limit - tightest.used);
  const usedFraction = tightest.limit === 0 ? 1 : tightest.used / tightest.limit;
  const allowed = remaining > 0;
  const warning = usedFraction >= 0.95 ? "95" : usedFraction >= 0.8 ? "80" : null;
  return { allowed, blockedBy: allowed ? null : tightest.name, remaining, usedFraction, warning };
}

/** Rough token estimate when a provider does not report usage (~4 chars per token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function formatTokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unlimited";
  if (n >= 1_000_000_000) return `${+(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${+(n / 1_000).toFixed(1)}K`;
  return String(n);
}
