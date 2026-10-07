/**
 * Groups: people who share models and a token budget across every workspace they belong to.
 * Admin → Groups manages them; Settings → Usage shows a person their share.
 */
import { and, asc, eq, gte, inArray, model, sql, usageEvent, user, userGroup, userGroupMember, userGroupModel } from "@aatmiq/db";
import { periodStart } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, parse, requireOrgCap, requireUser, type AppContext } from "../context";
import { badRequest, conflict, notFound } from "../errors";
import { getGroupQuotaStatus, getOrgPeriod } from "../services/quota";

const tokens = z.number().int().min(0).max(1e12).nullable();
const groupSchema = z.object({
  name: z.string().trim().min(2).max(60),
  description: z.string().trim().max(280).nullable().optional(),
  tokenLimit: tokens.optional(),
  memberTokenLimit: tokens.optional(),
  memberIds: z.array(z.string()).max(5000).optional(),
  modelIds: z.array(z.string()).max(500).optional(),
});

export async function groupRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db } = ctx;

  async function checkIds(memberIds: string[] | undefined, modelIds: string[] | undefined) {
    if (memberIds?.length) {
      const found = await db.select({ id: user.id }).from(user).where(inArray(user.id, memberIds));
      if (found.length !== new Set(memberIds).size) throw badRequest("Unknown person in members");
    }
    if (modelIds?.length) {
      const found = await db.select({ id: model.id }).from(model).where(and(inArray(model.id, modelIds), eq(model.kind, "chat")));
      if (found.length !== new Set(modelIds).size) throw badRequest("Unknown model (only chat models can be given to a group)");
    }
  }

  async function setMembersAndModels(groupId: string, memberIds: string[] | undefined, modelIds: string[] | undefined) {
    if (memberIds) {
      await db.delete(userGroupMember).where(eq(userGroupMember.groupId, groupId));
      if (memberIds.length) await db.insert(userGroupMember).values([...new Set(memberIds)].map((userId) => ({ groupId, userId })));
    }
    if (modelIds) {
      await db.delete(userGroupModel).where(eq(userGroupModel.groupId, groupId));
      if (modelIds.length) await db.insert(userGroupModel).values([...new Set(modelIds)].map((modelId) => ({ groupId, modelId })));
    }
  }

  const nameTaken = (e: unknown) => /unique|duplicate/i.test(String((e as { cause?: { message?: string } }).cause?.message ?? (e as Error).message));

  app.get("/api/admin/groups", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.budgets.manage");
    const start = periodStart(await getOrgPeriod(db));
    const [groups, members, models, usage] = await Promise.all([
      db.select().from(userGroup).orderBy(asc(userGroup.name)),
      db
        .select({ groupId: userGroupMember.groupId, id: user.id, name: user.name, email: user.email, image: user.image, status: user.status })
        .from(userGroupMember)
        .innerJoin(user, eq(user.id, userGroupMember.userId))
        .orderBy(asc(user.name)),
      db.select({ groupId: userGroupModel.groupId, id: model.id, displayName: model.displayName, enabled: model.enabled }).from(userGroupModel).innerJoin(model, eq(model.id, userGroupModel.modelId)).orderBy(asc(model.displayName)),
      db
        .select({ groupId: usageEvent.groupId, userId: usageEvent.userId, n: sql<number>`coalesce(sum(${usageEvent.inputTokens} + ${usageEvent.outputTokens}), 0)::bigint` })
        .from(usageEvent)
        .where(and(sql`${usageEvent.groupId} is not null`, gte(usageEvent.createdAt, start)))
        .groupBy(usageEvent.groupId, usageEvent.userId),
    ]);
    return groups.map((g) => {
      const used = usage.filter((x) => x.groupId === g.id);
      return {
        ...g,
        used: used.reduce((s, x) => s + Number(x.n), 0),
        members: members.filter((m) => m.groupId === g.id).map(({ groupId: _g, ...m }) => ({ ...m, used: Number(used.find((x) => x.userId === m.id)?.n ?? 0) })),
        models: models.filter((m) => m.groupId === g.id).map(({ groupId: _g, ...m }) => m),
      };
    });
  });

  app.post("/api/admin/groups", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.budgets.manage");
    const b = parse(groupSchema, req.body);
    await checkIds(b.memberIds, b.modelIds);
    const [g] = await db
      .insert(userGroup)
      .values({ name: b.name, description: b.description || null, tokenLimit: b.tokenLimit ?? null, memberTokenLimit: b.memberTokenLimit ?? null })
      .returning()
      .catch((e) => {
        throw nameTaken(e) ? conflict("A group with that name already exists.") : e;
      });
    await setMembersAndModels(g!.id, b.memberIds ?? [], b.modelIds ?? []);
    await audit(ctx, { actor: u, action: "group.created", targetType: "group", targetId: g!.id, meta: { name: b.name, members: b.memberIds?.length ?? 0, models: b.modelIds?.length ?? 0 } });
    return g;
  });

  app.patch<{ Params: { id: string } }>("/api/admin/groups/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.budgets.manage");
    const b = parse(groupSchema.partial(), req.body);
    const [g] = await db.select().from(userGroup).where(eq(userGroup.id, req.params.id));
    if (!g) throw notFound("Group not found");
    await checkIds(b.memberIds, b.modelIds);
    const { memberIds, modelIds, ...fields } = b;
    if (Object.keys(fields).length)
      await db
        .update(userGroup)
        .set({ ...fields, ...(fields.description !== undefined ? { description: fields.description || null } : {}), updatedAt: new Date() })
        .where(eq(userGroup.id, g.id))
        .catch((e) => {
          throw nameTaken(e) ? conflict("A group with that name already exists.") : e;
        });
    await setMembersAndModels(g.id, memberIds, modelIds);
    await audit(ctx, { actor: u, action: "group.updated", targetType: "group", targetId: g.id, meta: { ...fields, ...(memberIds ? { members: memberIds.length } : {}), ...(modelIds ? { models: modelIds.length } : {}) } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/admin/groups/:id", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.budgets.manage");
    const [g] = await db.delete(userGroup).where(eq(userGroup.id, req.params.id)).returning();
    if (!g) throw notFound("Group not found");
    await audit(ctx, { actor: u, action: "group.deleted", targetType: "group", targetId: g.id, meta: { name: g.name } });
    return { ok: true };
  });

  /** The groups you're in: what each gives you and how much of your share is left. */
  app.get("/api/me/groups", async (req) => {
    const u = await requireUser(ctx, req);
    const mine = await db
      .select({ id: userGroup.id, name: userGroup.name, description: userGroup.description })
      .from(userGroupMember)
      .innerJoin(userGroup, eq(userGroup.id, userGroupMember.groupId))
      .where(eq(userGroupMember.userId, u.id))
      .orderBy(asc(userGroup.name));
    const models = mine.length
      ? await db
          .select({ groupId: userGroupModel.groupId, id: model.id, displayName: model.displayName })
          .from(userGroupModel)
          .innerJoin(model, eq(model.id, userGroupModel.modelId))
          .where(and(inArray(userGroupModel.groupId, mine.map((g) => g.id)), eq(model.enabled, true)))
          .orderBy(asc(model.displayName))
      : [];
    return Promise.all(
      mine.map(async (g) => ({
        ...g,
        models: models.filter((m) => m.groupId === g.id).map(({ groupId: _g, ...m }) => m),
        quota: await getGroupQuotaStatus(db, g.id, u.id),
      })),
    );
  });
}
