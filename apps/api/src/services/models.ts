import { and, asc, eq, model, modelProvider, workspace, workspaceModel, type DB } from "@aatmiq/db";
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
  isDefault: boolean;
}

/** Models a workspace member may use in a section: org-enabled ∩ workspace-enabled ∩ section. */
export async function availableModels(db: DB, workspaceId: string, section: Section): Promise<AvailableModel[]> {
  const [ws] = await db.select({ d: workspace.defaultModelId }).from(workspace).where(eq(workspace.id, workspaceId));
  const rows = await db
    .select({
      id: model.id,
      displayName: model.displayName,
      modelKey: model.modelKey,
      sections: model.sections,
      contextLength: model.contextLength,
      providerName: modelProvider.name,
      providerType: modelProvider.type,
    })
    .from(workspaceModel)
    .innerJoin(model, eq(model.id, workspaceModel.modelId))
    .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
    .where(and(eq(workspaceModel.workspaceId, workspaceId), eq(model.enabled, true), eq(model.kind, "chat")))
    .orderBy(asc(model.displayName));
  return rows
    .filter((r) => r.sections.includes(section))
    .map(({ sections: _s, ...r }) => ({ ...r, isDefault: r.id === ws?.d }));
}

export async function resolveModel(
  db: DB,
  box: SecretBox,
  workspaceId: string,
  section: Section,
  requested: string | null | undefined,
) {
  const models = await availableModels(db, workspaceId, section);
  const chosen =
    (requested && models.find((m) => m.id === requested)) ||
    models.find((m) => m.isDefault) ||
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
