import { and, asc, eq, model, modelProvider, userGroup, userGroupMember, userGroupModel, workspace, workspaceModel, type DB } from "@aatmiq/db";
import type { ProviderConfig } from "@aatmiq/model-gateway";
import type { Section } from "@aatmiq/shared";
import type { SecretBox } from "../crypto";
import { badRequest } from "../errors";

export interface AvailableModel {
  id: string;
  displayName: string;
  modelKey: string;
  providerName: string;
  providerType: string;
  contextLength: number | null;
  vision: boolean;
  isDefault: boolean;
  /** Groups that give this model when the workspace doesn't; they pay for its use. Empty: the workspace pays. */
  groups: { id: string; name: string }[];
}

const modelColumns = {
  id: model.id,
  displayName: model.displayName,
  modelKey: model.modelKey,
  sections: model.sections,
  contextLength: model.contextLength,
  vision: model.vision,
  providerName: modelProvider.name,
  providerType: modelProvider.type,
};

/**
 * Models a person may use in a workspace and section: the workspace's models, plus the models of
 * the person's groups (org-enabled chat models offered in that section).
 */
export async function availableModels(db: DB, workspaceId: string, section: Section, userId?: string): Promise<AvailableModel[]> {
  const [ws] = await db.select({ d: workspace.defaultModelId }).from(workspace).where(eq(workspace.id, workspaceId));
  const own = await db
    .select(modelColumns)
    .from(workspaceModel)
    .innerJoin(model, eq(model.id, workspaceModel.modelId))
    .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
    .where(and(eq(workspaceModel.workspaceId, workspaceId), eq(model.enabled, true), eq(model.kind, "chat")))
    .orderBy(asc(model.displayName));
  const viaGroups = userId
    ? await db
        .select({ ...modelColumns, groupId: userGroup.id, groupName: userGroup.name })
        .from(userGroupMember)
        .innerJoin(userGroup, eq(userGroup.id, userGroupMember.groupId))
        .innerJoin(userGroupModel, eq(userGroupModel.groupId, userGroup.id))
        .innerJoin(model, eq(model.id, userGroupModel.modelId))
        .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
        .where(and(eq(userGroupMember.userId, userId), eq(model.enabled, true), eq(model.kind, "chat")))
        .orderBy(asc(userGroup.name))
    : [];
  const out = new Map<string, AvailableModel>();
  for (const { sections, ...r } of own) if (sections.includes(section)) out.set(r.id, { ...r, isDefault: r.id === ws?.d, groups: [] });
  for (const { sections, groupId, groupName, ...r } of viaGroups) {
    if (!sections.includes(section)) continue;
    const have = out.get(r.id);
    if (!have) out.set(r.id, { ...r, isDefault: false, groups: [{ id: groupId, name: groupName }] });
    // A model the workspace offers stays the workspace's; only group-only models collect groups.
    else if (have.groups.length) have.groups.push({ id: groupId, name: groupName });
  }
  return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function resolveModel(
  db: DB,
  box: SecretBox,
  workspaceId: string,
  section: Section,
  requested: string | null | undefined,
  userId?: string,
) {
  const models = await availableModels(db, workspaceId, section, userId);
  // Without a choice: the workspace default, then a workspace model, then a group's.
  const chosen =
    (requested && models.find((m) => m.id === requested)) ||
    models.find((m) => m.isDefault) ||
    models.find((m) => !m.groups.length) ||
    models[0];
  if (!chosen) throw badRequest("No model is available in this workspace. Ask your admin to enable one.");
  if (requested && chosen.id !== requested) throw badRequest("That model is not available to you in this workspace.");

  const [row] = await db
    .select({ provider: modelProvider })
    .from(model)
    .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
    .where(eq(model.id, chosen.id));
  const p = row!.provider;
  const cfg: ProviderConfig = {
    id: p.id,
    type: p.type,
    baseUrl: p.baseUrl,
    apiKey: p.apiKeyEnc ? box.decrypt(p.apiKeyEnc) : null,
  };
  return { model: chosen, provider: cfg };
}
