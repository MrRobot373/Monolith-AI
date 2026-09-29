/**
 * Project access (docs/03-projects.md).
 * - owner: full control
 * - "edit": instructions, sources, members
 * - "chat": chat inside the project, read instructions and sources, read chats shared to the project
 * Org admins and workspace admins can manage every project in their workspace.
 * Chats stay private to their author unless shared to the project.
 */
import { and, eq, or, project, projectMember, sql, type DB } from "@aatmiq/db";
import { isOrgAdmin } from "@aatmiq/shared";
import type { AppContext, SessionUser } from "../context";
import { requireWorkspaceCap } from "../context";
import { forbidden, notFound } from "../errors";

export type ProjectRole = "owner" | "edit" | "chat";

export async function isWorkspaceAdmin(ctx: AppContext, u: SessionUser, workspaceId: string): Promise<boolean> {
  const m = await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
  return isOrgAdmin(u.orgRole) || m?.role === "admin";
}

export async function getProjectAccess(ctx: AppContext, u: SessionUser, projectId: string) {
  const [p] = await ctx.db.select().from(project).where(eq(project.id, projectId));
  if (!p) throw notFound("Project not found");
  const admin = await isWorkspaceAdmin(ctx, u, p.workspaceId).catch(() => false);
  const [m] = await ctx.db
    .select({ role: projectMember.role })
    .from(projectMember)
    .where(and(eq(projectMember.projectId, p.id), eq(projectMember.userId, u.id)));
  let role: ProjectRole | null = null;
  if (p.ownerId === u.id) role = "owner";
  else if (m?.role === "edit" || admin) role = "edit";
  else if (m || p.visibility === "workspace") role = "chat";
  if (!role) throw notFound("Project not found");
  return { project: p, role, admin, canEdit: role !== "chat" };
}

export async function requireProjectEdit(ctx: AppContext, u: SessionUser, projectId: string) {
  const a = await getProjectAccess(ctx, u, projectId);
  if (!a.canEdit) throw forbidden("You need edit access to this project.");
  return a;
}

/** SQL condition on `project` rows the user can open (admins: all in the workspace). */
export function projectVisibleTo(userId: string, admin: boolean) {
  if (admin) return sql`true`;
  return or(
    eq(project.ownerId, userId),
    eq(project.visibility, "workspace"),
    sql`exists (select 1 from project_member pm where pm.project_id = "project"."id" and pm.user_id = ${userId})`,
  )!;
}

/** Raw SQL: is document `docIdSql` a source of any project this user can open? */
export function docInAccessibleProject(docIdSql: ReturnType<typeof sql.raw>, userId: string) {
  return sql`exists (
    select 1 from project_source ps join project p on p.id = ps.project_id
    where ps.document_id = ${docIdSql}
      and (p.owner_id = ${userId} or p.visibility = 'workspace'
           or exists (select 1 from project_member pm where pm.project_id = p.id and pm.user_id = ${userId})
           or exists (select 1 from workspace_member wm join "user" u on u.id = wm.user_id
                      where wm.workspace_id = p.workspace_id and wm.user_id = ${userId} and wm.role = 'admin')
           or exists (select 1 from "user" u where u.id = ${userId} and u.org_role in ('owner', 'admin'))))`;
}

export async function projectDb(db: DB, id: string) {
  const [p] = await db.select().from(project).where(eq(project.id, id));
  return p ?? null;
}
