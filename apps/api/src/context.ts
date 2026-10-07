import {
  account,
  and,
  auditLog,
  eq,
  isNull,
  notification,
  organization,
  sql,
  user,
  workspace,
  workspaceMember,
  type DB,
} from "@aatmiq/db";
import {
  orgCan,
  workspaceCan,
  type OrgCapability,
  type OrgRole,
  type WorkspaceCapability,
  type WorkspaceRole,
} from "@aatmiq/shared";
import { fromNodeHeaders } from "better-auth/node";
import type { FastifyRequest } from "fastify";
import type { z } from "zod";
import type { Auth } from "./auth";
import type { Config } from "./config";
import type { SecretBox } from "./crypto";
import type { LicenseService } from "./services/license";
import type { Storage } from "./services/storage";
import type { WorkRunner } from "./services/work";
import type { CodeServers } from "./services/code";
import type { Connectors } from "./services/connectors";
import type { Mailer } from "./services/mail";
import type { Jobs } from "./services/jobs";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "./errors";

export interface AppContext {
  db: DB;
  auth: Auth;
  cfg: Config;
  box: SecretBox;
  storage: Storage;
  license: LicenseService;
  work: WorkRunner;
  code: CodeServers;
  connectors: Connectors;
  mail: Mailer;
  jobs: Jobs;
}

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  image: string | null;
  orgRole: OrgRole;
  /** The org requires two-step sign-in and this person signs in with a password but hasn't set it up. */
  twoFactorSetupRequired?: boolean;
}

/** The only routes open to someone who still has to set up the required two-step sign-in. */
const TWO_FACTOR_SETUP_ROUTES = new Set(["/api/me", "/api/me/security", "/api/me/email/verify"]);

export function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data ?? {});
  if (!r.success) {
    const first = r.error.issues[0];
    throw badRequest(first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input", r.error.issues);
  }
  return r.data;
}

export async function getSessionUser(ctx: AppContext, req: FastifyRequest): Promise<SessionUser | null> {
  const s = await ctx.auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!s) return null;
  const [u] = await ctx.db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      orgRole: user.orgRole,
      status: user.status,
      twoFactorEnabled: user.twoFactorEnabled,
      // Raw "user"."id": Drizzle drops table prefixes in single-table selects, so ${user.id} would bind to account.id.
      hasPassword: sql<boolean>`exists (select 1 from ${account} where ${account.userId} = ${sql.raw(`"user"."id"`)} and ${account.providerId} = 'credential')`,
      twoFactorRequired: sql<boolean>`coalesce((select ${organization.twoFactorRequired} from ${organization} limit 1), false)`,
      ssoRequired: sql<boolean>`coalesce((select ${organization.ssoRequired} from ${organization} limit 1), false)`,
    })
    .from(user)
    .where(eq(user.id, s.user.id));
  if (!u || u.status !== "active") return null;
  // Single sign-on users are exempt: the identity provider runs its own check.
  const usesPassword = u.hasPassword && (!u.ssoRequired || u.orgRole === "owner");
  const twoFactorSetupRequired = u.twoFactorRequired && usesPassword && !u.twoFactorEnabled;
  return { id: u.id, name: u.name, email: u.email, image: u.image, orgRole: u.orgRole, twoFactorSetupRequired };
}

export async function requireUser(ctx: AppContext, req: FastifyRequest): Promise<SessionUser> {
  const u = await getSessionUser(ctx, req);
  if (!u) throw unauthorized();
  if (u.twoFactorSetupRequired && !TWO_FACTOR_SETUP_ROUTES.has(req.routeOptions?.url ?? "")) {
    throw new HttpError(403, "Your organization requires two-step sign-in. Set it up to continue.", "two_factor_required");
  }
  return u;
}

export function requireOrgCap(u: SessionUser, cap: OrgCapability): void {
  if (!orgCan(u.orgRole, cap)) throw forbidden();
}

export async function getMembership(db: DB, workspaceId: string, userId: string) {
  const [m] = await db
    .select()
    .from(workspaceMember)
    .where(and(eq(workspaceMember.workspaceId, workspaceId), eq(workspaceMember.userId, userId)));
  return m ?? null;
}

export async function getActiveWorkspace(db: DB, workspaceId: string) {
  const [ws] = await db
    .select()
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), isNull(workspace.archivedAt)));
  if (!ws) throw notFound("Workspace not found");
  return ws;
}

/** Throws unless the user holds `cap` in the workspace. Returns the membership (null for org admins who aren't members). */
export async function requireWorkspaceCap(
  ctx: AppContext,
  u: SessionUser,
  workspaceId: string,
  cap: WorkspaceCapability,
) {
  await getActiveWorkspace(ctx.db, workspaceId);
  const m = await getMembership(ctx.db, workspaceId, u.id);
  if (!workspaceCan(u.orgRole, (m?.role as WorkspaceRole | undefined) ?? null, cap)) {
    throw m ? forbidden() : notFound("Workspace not found");
  }
  return m;
}

export async function getOrg(db: DB) {
  const [org] = await db.select().from(organization).limit(1);
  return org ?? null;
}

export async function audit(
  ctx: AppContext,
  entry: {
    actor?: SessionUser | null;
    action: string;
    workspaceId?: string | null;
    targetType?: string;
    targetId?: string;
    meta?: Record<string, unknown>;
    ip?: string;
  },
): Promise<void> {
  await ctx.db.insert(auditLog).values({
    actorId: entry.actor?.id ?? null,
    actorEmail: entry.actor?.email ?? null,
    action: entry.action,
    workspaceId: entry.workspaceId ?? null,
    targetType: entry.targetType ?? null,
    targetId: entry.targetId ?? null,
    meta: entry.meta ?? null,
    ip: entry.ip ?? null,
  });
}

export async function notify(
  db: DB,
  userIds: string[],
  n: { type: string; title: string; body?: string; link?: string },
): Promise<void> {
  const unique = [...new Set(userIds)];
  if (unique.length === 0) return;
  await db.insert(notification).values(unique.map((userId) => ({ userId, ...n })));
}
