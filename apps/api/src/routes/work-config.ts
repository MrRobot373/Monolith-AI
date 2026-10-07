/**
 * Work AI configuration: skills (org + personal), schedules and the org policy. Connectors: routes/connectors.ts.
 */
import { and, asc, eq, ne, or, organization, skill, sql, workSchedule, workTask } from "@aatmiq/db";
import { librarySkill, librarySkills } from "@aatmiq/skills";
import { DEFAULT_WORK_SETTINGS, orgCan, scheduleSchema, skillSchema, workSettingsSchema } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, parse, requireOrgCap, requireUser, type AppContext, type SessionUser } from "../context";
import { badRequest, forbidden, notFound } from "../errors";
import { resolveModel } from "../services/models";
import { assertReasonable, nextRun, runSchedule } from "../services/schedules";
import { getWorkSettings, slugify } from "../services/work";
import { requireWorkSection } from "./work";

const canManageWork = (u: SessionUser) => orgCan(u.orgRole, "org.work.manage");

export async function workConfigRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box } = ctx;

  /* ───────────── Skills ───────────── */

  const skillView = (u: SessionUser) => (s: typeof skill.$inferSelect) => ({
    ...s,
    editable: s.scope === "personal" ? s.ownerId === u.id : canManageWork(u),
  });

  app.get("/api/work/skills", async (req) => {
    const u = await requireUser(ctx, req);
    const rows = await db
      .select()
      .from(skill)
      .where(
        or(
          and(eq(skill.scope, "org"), canManageWork(u) ? undefined : eq(skill.enabled, true)),
          and(eq(skill.scope, "personal"), eq(skill.ownerId, u.id)),
        ),
      )
      .orderBy(asc(skill.scope), asc(skill.name));
    return rows.map(skillView(u));
  });

  async function uniqueSlug(name: string, scope: "org" | "personal", ownerId: string | null, exceptId?: string) {
    const base = slugify(name);
    const taken = new Set(
      (
        await db
          .select({ slug: skill.slug })
          .from(skill)
          .where(and(eq(skill.scope, scope), scope === "personal" ? eq(skill.ownerId, ownerId!) : undefined, exceptId ? ne(skill.id, exceptId) : undefined))
      ).map((r) => r.slug),
    );
    let slug = base;
    for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
    return slug;
  }

  async function loadEditableSkill(u: SessionUser, id: string) {
    const [s] = await db.select().from(skill).where(eq(skill.id, id));
    if (!s || (s.scope === "personal" && s.ownerId !== u.id)) throw notFound("Skill not found");
    if (s.scope === "org" && !canManageWork(u)) throw forbidden("Only admins can change organization skills.");
    return s;
  }

  app.post("/api/work/skills", async (req) => {
    const u = await requireUser(ctx, req);
    const b = parse(skillSchema, req.body);
    if (b.scope === "org" && !canManageWork(u)) throw forbidden("Only admins can add organization skills.");
    const ownerId = b.scope === "personal" ? u.id : null;
    const [s] = await db
      .insert(skill)
      .values({ ...b, ownerId, slug: await uniqueSlug(b.name, b.scope, ownerId) })
      .returning();
    if (b.scope === "org") await audit(ctx, { actor: u, action: "work.skill.added", targetType: "skill", targetId: s!.id, meta: { name: b.name } });
    return skillView(u)(s!);
  });

  app.patch<{ Params: { id: string } }>("/api/work/skills/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const s = await loadEditableSkill(u, req.params.id);
    const b = parse(skillSchema.omit({ scope: true }).partial(), req.body);
    const [row] = await db
      .update(skill)
      .set({ ...b, ...(b.name && b.name !== s.name ? { slug: await uniqueSlug(b.name, s.scope, s.ownerId, s.id) } : {}), updatedAt: new Date() })
      .where(eq(skill.id, s.id))
      .returning();
    if (s.scope === "org") await audit(ctx, { actor: u, action: "work.skill.updated", targetType: "skill", targetId: s.id });
    return skillView(u)(row!);
  });

  app.delete<{ Params: { id: string } }>("/api/work/skills/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const s = await loadEditableSkill(u, req.params.id);
    await db.delete(skill).where(eq(skill.id, s.id));
    if (s.scope === "org") await audit(ctx, { actor: u, action: "work.skill.deleted", targetType: "skill", targetId: s.id, meta: { name: s.name } });
    return { ok: true };
  });

  /* ───────────── Skill library (built in) ───────────── */

  /** The built-in library: everyone sees what's on; admins also see what's off. */
  app.get("/api/work/skills/library", async (req) => {
    const u = await requireUser(ctx, req);
    const off = new Set((await getWorkSettings(db)).disabledLibrarySkills);
    return librarySkills()
      .filter((s) => canManageWork(u) || !off.has(s.slug))
      .map((s) => ({ slug: s.slug, name: s.title, description: s.description, category: s.category, files: s.files, enabled: !off.has(s.slug) }));
  });

  app.get<{ Params: { slug: string } }>("/api/work/skills/library/:slug", async (req) => {
    await requireUser(ctx, req);
    const s = librarySkill(req.params.slug);
    if (!s) throw notFound("Skill not found");
    return { slug: s.slug, name: s.title, description: s.description, category: s.category, body: s.body, files: s.files };
  });

  app.patch<{ Params: { slug: string } }>("/api/work/skills/library/:slug", async (req) => {
    const u = await requireUser(ctx, req);
    if (!canManageWork(u)) throw forbidden("Only admins can turn library skills on or off.");
    const s = librarySkill(req.params.slug);
    if (!s) throw notFound("Skill not found");
    const { enabled } = parse(z.object({ enabled: z.boolean() }), req.body);
    const [org] = await db.select({ id: organization.id, s: organization.workSettings }).from(organization).limit(1);
    if (!org) throw notFound("Organization not found");
    const off = new Set(org.s?.disabledLibrarySkills ?? []);
    if (enabled) off.delete(s.slug);
    else off.add(s.slug);
    await db
      .update(organization)
      .set({ workSettings: { ...(org.s ?? {}), disabledLibrarySkills: [...off].sort() } })
      .where(eq(organization.id, org.id));
    await audit(ctx, { actor: u, action: enabled ? "work.library_skill.enabled" : "work.library_skill.disabled", targetType: "skill", targetId: s.slug });
    return { slug: s.slug, enabled };
  });

  /* ───────────── Schedules ───────────── */

  app.get<{ Querystring: { workspaceId?: string } }>("/api/work/schedules", async (req) => {
    const u = await requireUser(ctx, req);
    const wsId = req.query.workspaceId ?? "";
    await requireWorkSection(ctx, u, wsId);
    return db
      .select({
        id: workSchedule.id,
        name: workSchedule.name,
        prompt: workSchedule.prompt,
        cron: workSchedule.cron,
        timezone: workSchedule.timezone,
        modelId: workSchedule.modelId,
        enabled: workSchedule.enabled,
        nextRunAt: workSchedule.nextRunAt,
        lastRunAt: workSchedule.lastRunAt,
        lastTaskId: workSchedule.lastTaskId,
        lastStatus: workTask.status,
        createdAt: workSchedule.createdAt,
      })
      .from(workSchedule)
      .leftJoin(workTask, eq(workTask.id, workSchedule.lastTaskId))
      .where(and(eq(workSchedule.workspaceId, wsId), eq(workSchedule.userId, u.id)))
      .orderBy(asc(workSchedule.name));
  });

  async function loadOwnSchedule(u: SessionUser, id: string) {
    const [s] = await db.select().from(workSchedule).where(eq(workSchedule.id, id));
    if (!s || s.userId !== u.id) throw notFound("Schedule not found");
    return s;
  }

  app.post("/api/work/schedules", async (req) => {
    const u = await requireUser(ctx, req);
    const b = parse(scheduleSchema, req.body);
    await requireWorkSection(ctx, u, b.workspaceId);
    if (b.modelId) await resolveModel(db, box, b.workspaceId, "work", b.modelId);
    assertReasonable(b.cron, b.timezone);
    const [s] = await db
      .insert(workSchedule)
      .values({ ...b, modelId: b.modelId ?? null, userId: u.id, nextRunAt: b.enabled ? nextRun(b.cron, b.timezone) : null })
      .returning();
    return s;
  });

  app.patch<{ Params: { id: string } }>("/api/work/schedules/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const s = await loadOwnSchedule(u, req.params.id);
    const b = parse(scheduleSchema.omit({ workspaceId: true }).partial(), req.body);
    if (b.modelId) await resolveModel(db, box, s.workspaceId, "work", b.modelId);
    const next = { ...s, ...b };
    assertReasonable(next.cron, next.timezone);
    const [row] = await db
      .update(workSchedule)
      .set({ ...b, nextRunAt: next.enabled ? nextRun(next.cron, next.timezone) : null, updatedAt: new Date() })
      .where(eq(workSchedule.id, s.id))
      .returning();
    return row;
  });

  app.delete<{ Params: { id: string } }>("/api/work/schedules/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const s = await loadOwnSchedule(u, req.params.id);
    await db.delete(workSchedule).where(eq(workSchedule.id, s.id));
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>("/api/work/schedules/:id/run", async (req) => {
    const u = await requireUser(ctx, req);
    const s = await loadOwnSchedule(u, req.params.id);
    await requireWorkSection(ctx, u, s.workspaceId);
    const t = await runSchedule(ctx, s);
    if (!t) throw forbidden("Work AI isn't included in your organization's license.");
    return { taskId: t.id };
  });

  /** Preview the next runs of a cron expression (for the schedule editor). */
  app.get<{ Querystring: { cron?: string; timezone?: string } }>("/api/work/schedules/preview", async (req) => {
    await requireUser(ctx, req);
    const cron = req.query.cron ?? "";
    const tz = req.query.timezone || "UTC";
    if (cron.trim().split(/\s+/).length !== 5) throw badRequest("Use five fields: minute hour day month weekday");
    const runs: string[] = [];
    let from = new Date();
    for (let i = 0; i < 3; i++) {
      from = nextRun(cron, tz, from);
      runs.push(from.toISOString());
    }
    return { runs };
  });

  /* ───────────── Org policy (admin) ───────────── */

  app.get("/api/admin/work", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const settings = await getWorkSettings(db);
    const [counts] = await db
      .select({
        running: sql<number>`count(*) filter (where ${workTask.status} in ('running','needs_approval'))::int`,
        queued: sql<number>`count(*) filter (where ${workTask.status} = 'queued')::int`,
        week: sql<number>`count(*) filter (where ${workTask.createdAt} > now() - interval '7 days')::int`,
      })
      .from(workTask);
    return { settings, defaults: DEFAULT_WORK_SETTINGS, licensed: await ctx.license.hasSection("work"), stats: counts };
  });

  app.put("/api/admin/work", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const b = parse(workSettingsSchema, req.body);
    const [org] = await db.select({ id: organization.id, s: organization.workSettings }).from(organization).limit(1);
    if (!org) throw notFound("Organization not found");
    const merged = { ...(org.s ?? {}), ...b };
    await db.update(organization).set({ workSettings: merged }).where(eq(organization.id, org.id));
    await audit(ctx, { actor: u, action: "work.settings.updated", targetType: "organization", targetId: org.id, meta: b });
    return { ...DEFAULT_WORK_SETTINGS, ...merged };
  });

  /** Try a SearXNG server before saving it. */
  app.post("/api/admin/work/test-search", async (req) => {
    const u = await requireUser(ctx, req);
    requireOrgCap(u, "org.work.manage");
    const { url } = parse(z.object({ url: z.url() }), req.body);
    const target = new URL("search", url.replace(/\/?$/, "/"));
    target.searchParams.set("q", "aatmiq");
    target.searchParams.set("format", "json");
    try {
      const r = await fetch(target, { signal: AbortSignal.timeout(10_000), headers: { accept: "application/json" } });
      if (r.status === 403) return { ok: false, error: "SearXNG refused JSON results. Add `json` to search.formats in its settings.yml." };
      if (!r.ok) return { ok: false, error: `SearXNG answered ${r.status}.` };
      const json = (await r.json()) as { results?: unknown[] };
      return { ok: true, results: json.results?.length ?? 0 };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "Couldn't reach the server." };
    }
  });

}
