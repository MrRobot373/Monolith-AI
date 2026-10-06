/**
 * Roles and capabilities. See docs/01-foundation.md §2.
 * Permissions are named capabilities mapped to roles, so custom roles can be added later
 * without a schema change.
 */

export const ORG_ROLES = ["owner", "admin", "member"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const WORKSPACE_ROLES = ["admin", "member"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const SECTIONS = ["chat", "work", "code"] as const;
export type Section = (typeof SECTIONS)[number];

export const ORG_CAPABILITIES = [
  "org.users.invite",
  "org.users.manage",
  "org.workspaces.manage",
  "org.auth.manage",
  "org.providers.manage",
  "org.models.manage",
  "org.budgets.manage",
  "org.usage.view",
  "org.audit.view",
  "org.branding.manage",
  "org.license.view",
  "org.license.manage",
  "org.work.manage",
] as const;
export type OrgCapability = (typeof ORG_CAPABILITIES)[number];

export const WORKSPACE_CAPABILITIES = [
  "workspace.members.manage",
  "workspace.models.grant",
  "workspace.quotas.manage",
  "workspace.requests.decide",
  "workspace.usage.view",
  "workspace.audit.view",
  "workspace.use",
] as const;
export type WorkspaceCapability = (typeof WORKSPACE_CAPABILITIES)[number];

const ORG_ROLE_CAPS: Record<OrgRole, readonly OrgCapability[]> = {
  owner: ORG_CAPABILITIES,
  admin: ORG_CAPABILITIES.filter((c) => c !== "org.license.manage"),
  member: [],
};

const WORKSPACE_ROLE_CAPS: Record<WorkspaceRole, readonly WorkspaceCapability[]> = {
  admin: WORKSPACE_CAPABILITIES,
  member: ["workspace.use"],
};

export function orgCan(role: OrgRole, cap: OrgCapability): boolean {
  return ORG_ROLE_CAPS[role].includes(cap);
}

/**
 * Org owners/admins implicitly hold every workspace capability in every workspace.
 * `wsRole` is null when the user is not a member of the workspace.
 */
export function workspaceCan(
  orgRole: OrgRole,
  wsRole: WorkspaceRole | null,
  cap: WorkspaceCapability,
): boolean {
  if (orgRole === "owner" || orgRole === "admin") return true;
  if (!wsRole) return false;
  return WORKSPACE_ROLE_CAPS[wsRole].includes(cap);
}

export function isOrgAdmin(role: OrgRole): boolean {
  return role === "owner" || role === "admin";
}
