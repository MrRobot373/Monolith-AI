import {
  and,
  asc,
  chat,
  desc,
  document,
  eq,
  inArray,
  isNull,
  message,
  or,
  project,
  projectMember,
  projectSource,
  sql,
  user,
  workspaceMember,
  workTask,
  connector,
} from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, parse, requireUser, requireWorkspaceCap, type AppContext } from "../context";
import { randomToken } from "../crypto";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { accessibleDocs, processDocument } from "../services/documents";
import { isSupported, SUPPORTED_HINT } from "../services/extract";
import { getProjectAccess, isWorkspaceAdmin, projectVisibleTo, requireProjectEdit } from "../services/projects";
import { MAX_UPLOAD_BYTES } from "./documents";

const createSchema = z.object({
  workspaceId: z.string(),
  name: z.string().trim().min(1).max(80),
  color: z.string().regex(/^\d{1,3}$/).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(8000).optional(),
});
const updateSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z.string().regex(/^\d{1,3}$/).optional(),
  description: z.string().max(500).nullable().optional(),
  instructions: z.string().max(8000).nullable().optional(),
  visibility: z.enum(["private", "workspace"]).optional(),
  /** Connectors Work AI tasks in the project may use; null: all the organization's. */
  connectorIds: z.array(z.string()).max(200).nullable().optional(),
});
const memberSchema = z.object({ userId: z.string(), role: z.enum(["chat", "edit"]).default("chat") });
const sourceUpdateSchema = z.object({
  label: z.enum(["confirmed", "assumption", "tbd"]).nullable().optional(),
  /** Mark this source as replaced by a newer one (another source of the project), or null to make it current again. */
  supersededById: z.string().nullable().optional(),
});
const noteSchema = z.object({
  title: z.string().trim().min(1).max(160),
  content: z.string().trim().min(1).max(200_000),
  kind: z.enum(["note", "answer"]).default("note"),
});

export async function projectRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, storage } = ctx;

  /** Co-members of a workspace, for share pickers. Any member can see names and emails of their workspace. */
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/people", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.params.id, "workspace.use");
    return db
      .select({ id: user.id, name: user.name, email: user.email, image: user.image })
      .from(workspaceMember)
      .innerJoin(user, eq(user.id, workspaceMember.userId))
      .where(and(eq(workspaceMember.workspaceId, req.params.id), eq(user.status, "active")))
      .orderBy(asc(user.name));
  });

  app.get<{ Querystring: { workspaceId: string } }>("/api/projects", async (req) => {
    const u = await requireUser(ctx, req);
    const admin = await isWorkspaceAdmin(ctx, u, req.query.workspaceId);
    const rows = await db
      .select({
        id: project.id,
        name: project.name,
        color: project.color,
        description: project.description,
        visibility: project.visibility,
        ownerId: project.ownerId,
        updatedAt: project.updatedAt,
        chatCount: sql<number>`(select count(*) from chat c where c.project_id = "project"."id" and c.user_id = ${u.id} and c.archived_at is null and not c.temporary)::int`,
        sourceCount: sql<number>`(select count(*) from project_source s where s.project_id = "project"."id")::int`,
        memberCount: sql<number>`(select count(*) from project_member m where m.project_id = "project"."id")::int`,
      })
      .from(project)
      .where(and(eq(project.workspaceId, req.query.workspaceId), projectVisibleTo(u.id, admin)))
      .orderBy(desc(project.updatedAt));
    return rows;
  });

  app.post("/api/projects", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(createSchema, req.body);
    await requireWorkspaceCap(ctx, u, body.workspaceId, "workspace.use");
    const [p] = await db.insert(project).values({ ...body, ownerId: u.id }).returning();
    await audit(ctx, { actor: u, action: "project.created", workspaceId: body.workspaceId, targetType: "project", targetId: p!.id, meta: { name: body.name } });
    return p;
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p, role, canEdit } = await getProjectAccess(ctx, u, req.params.id);
    const [sources, members, chats, owner, tasks] = await Promise.all([
      db
        .select({
          id: document.id,
          name: document.name,
          kind: document.kind,
          status: document.status,
          error: document.error,
          sizeBytes: document.sizeBytes,
          pageCount: document.pageCount,
          label: document.label,
          supersededById: document.supersededById,
          projectOnly: sql<boolean>`${document.projectId} is not null`,
          addedAt: projectSource.createdAt,
        })
        .from(projectSource)
        .innerJoin(document, eq(document.id, projectSource.documentId))
        .where(eq(projectSource.projectId, p.id))
        .orderBy(asc(projectSource.createdAt)),
      db
        .select({ userId: user.id, name: user.name, email: user.email, image: user.image, role: projectMember.role })
        .from(projectMember)
        .innerJoin(user, eq(user.id, projectMember.userId))
        .where(eq(projectMember.projectId, p.id))
        .orderBy(asc(user.name)),
      db
        .select({
          id: chat.id,
          title: chat.title,
          updatedAt: chat.updatedAt,
          userId: chat.userId,
          userName: user.name,
          sharedToProject: chat.sharedToProject,
          pinned: chat.pinned,
        })
        .from(chat)
        .innerJoin(user, eq(user.id, chat.userId))
        .where(
          and(eq(chat.projectId, p.id), isNull(chat.archivedAt), eq(chat.temporary, false), or(eq(chat.userId, u.id), eq(chat.sharedToProject, true))),
        )
        .orderBy(desc(chat.pinned), desc(chat.updatedAt))
        .limit(200),
      p.ownerId
        ? db.select({ id: user.id, name: user.name, email: user.email }).from(user).where(eq(user.id, p.ownerId)).then((r) => r[0] ?? null)
        : null,
      // Work AI tasks: the person's own, and those others shared to the project.
      db
        .select({
          id: workTask.id,
          title: workTask.title,
          status: workTask.status,
          updatedAt: workTask.updatedAt,
          userId: workTask.userId,
          userName: user.name,
          sharedToProject: workTask.sharedToProject,
          scheduleId: workTask.scheduleId,
        })
        .from(workTask)
        .innerJoin(user, eq(user.id, workTask.userId))
        .where(and(eq(workTask.projectId, p.id), or(eq(workTask.userId, u.id), eq(workTask.sharedToProject, true))))
        .orderBy(desc(workTask.updatedAt))
        .limit(200),
    ]);
    return { ...p, role, canEdit, owner, sources, members, chats, tasks };
  });

  app.patch<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const body = parse(updateSchema, req.body);
    if (body.connectorIds?.length) {
      const known = new Set((await db.select({ id: connector.id }).from(connector).where(inArray(connector.id, body.connectorIds))).map((c) => c.id));
      if (body.connectorIds.some((id) => !known.has(id))) throw badRequest("One of those connectors doesn't exist any more.");
    }
    const [updated] = await db.update(project).set(body).where(eq(project.id, p.id)).returning();
    await audit(ctx, {
      actor: u,
      action: body.visibility && body.visibility !== p.visibility ? `project.visibility_${body.visibility}` : "project.updated",
      workspaceId: p.workspaceId,
      targetType: "project",
      targetId: p.id,
      meta: { ...body, instructions: body.instructions !== undefined ? "(changed)" : undefined },
    });
    return updated;
  });

  /** Deleting removes the project's chats and project-only files. Library documents are kept. */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p, role, admin } = await getProjectAccess(ctx, u, req.params.id);
    if (role !== "owner" && !admin) throw forbidden("Only the project owner or a workspace admin can delete it.");
    const own = await db.select({ key: document.storageKey }).from(document).where(eq(document.projectId, p.id));
    await db.delete(project).where(eq(project.id, p.id));
    await Promise.all(own.map((d) => storage.remove(d.key).catch(() => {})));
    await audit(ctx, { actor: u, action: "project.deleted", workspaceId: p.workspaceId, targetType: "project", targetId: p.id, meta: { name: p.name } });
    return { ok: true };
  });

  /* ───────────── Members ───────────── */

  app.put<{ Params: { id: string } }>("/api/projects/:id/members", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const body = parse(memberSchema, req.body);
    if (body.userId === p.ownerId) throw badRequest("The owner already has full access.");
    const [wm] = await db
      .select({ id: workspaceMember.userId })
      .from(workspaceMember)
      .where(and(eq(workspaceMember.workspaceId, p.workspaceId), eq(workspaceMember.userId, body.userId)));
    if (!wm) throw badRequest("Only members of this workspace can be added.");
    await db
      .insert(projectMember)
      .values({ projectId: p.id, userId: body.userId, role: body.role })
      .onConflictDoUpdate({ target: [projectMember.projectId, projectMember.userId], set: { role: body.role } });
    await audit(ctx, { actor: u, action: "project.member_set", workspaceId: p.workspaceId, targetType: "user", targetId: body.userId, meta: { projectId: p.id, role: body.role } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string; userId: string } }>("/api/projects/:id/members/:userId", async (req) => {
    const u = await requireUser(ctx, req);
    const self = req.params.userId === u.id;
    const { project: p } = self ? await getProjectAccess(ctx, u, req.params.id) : await requireProjectEdit(ctx, u, req.params.id);
    await db.delete(projectMember).where(and(eq(projectMember.projectId, p.id), eq(projectMember.userId, req.params.userId)));
    await audit(ctx, { actor: u, action: "project.member_removed", workspaceId: p.workspaceId, targetType: "user", targetId: req.params.userId, meta: { projectId: p.id } });
    return { ok: true };
  });

  /* ───────────── Sources ───────────── */

  async function addSource(projectId: string, documentId: string, userId: string) {
    await db.insert(projectSource).values({ projectId, documentId, addedBy: userId }).onConflictDoNothing();
    await db.update(project).set({ updatedAt: new Date() }).where(eq(project.id, projectId));
  }

  app.post<{ Params: { id: string } }>("/api/projects/:id/sources/upload", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    if (!req.isMultipart()) throw badRequest("Send the file as multipart/form-data");
    const file = await req.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) throw badRequest("No file was uploaded");
    const data = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, "Files can be up to 25 MB.", "too_large");
    const name = file.filename.replace(/[\\/]/g, "_").slice(0, 200) || "Untitled";
    // "Upload a new version": the old source stays for reference but is left out of answers.
    const replacesField = file.fields.replaces as { value?: string } | undefined;
    const replaces = typeof replacesField?.value === "string" && replacesField.value ? replacesField.value : null;
    let oldLabel: "confirmed" | "assumption" | "tbd" | null = null;
    if (replaces) {
      const [old] = await db
        .select({ id: document.id, label: document.label })
        .from(projectSource)
        .innerJoin(document, eq(document.id, projectSource.documentId))
        .where(and(eq(projectSource.projectId, p.id), eq(projectSource.documentId, replaces)));
      if (!old) throw badRequest("The source to replace isn't in this project.");
      oldLabel = old.label;
    }
    if (!isSupported(name)) throw new HttpError(415, `This file type isn't supported yet. Upload ${SUPPORTED_HINT}.`, "unsupported");
    if (data.length === 0) throw badRequest("The file is empty");
    const storageKey = `${p.workspaceId}/${randomToken(18)}`;
    await storage.put(storageKey, data);
    const [doc] = await db
      .insert(document)
      .values({ workspaceId: p.workspaceId, projectId: p.id, ownerId: u.id, name, mimeType: file.mimetype || "application/octet-stream", sizeBytes: data.length, storageKey, label: oldLabel })
      .returning();
    await addSource(p.id, doc!.id, u.id);
    if (replaces) await db.update(document).set({ supersededById: doc!.id }).where(eq(document.id, replaces));
    await audit(ctx, { actor: u, action: "project.source_added", workspaceId: p.workspaceId, targetType: "document", targetId: doc!.id, meta: { projectId: p.id, name } });
    await ctx.jobs.document(doc!.id);
    return doc;
  });

  /** Pasted text or a saved answer, stored as a Markdown source. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/sources/note", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const body = parse(noteSchema, req.body);
    const name = body.title.replace(/[\\/]/g, "_") + (/\.(md|txt)$/i.test(body.title) ? "" : ".md");
    const data = Buffer.from(body.content, "utf8");
    const storageKey = `${p.workspaceId}/${randomToken(18)}`;
    await storage.put(storageKey, data);
    const [doc] = await db
      .insert(document)
      .values({ workspaceId: p.workspaceId, projectId: p.id, ownerId: u.id, name, kind: body.kind, mimeType: "text/markdown", sizeBytes: data.length, storageKey })
      .returning();
    await addSource(p.id, doc!.id, u.id);
    await audit(ctx, { actor: u, action: body.kind === "answer" ? "project.answer_saved" : "project.note_added", workspaceId: p.workspaceId, targetType: "document", targetId: doc!.id, meta: { projectId: p.id } });
    await ctx.jobs.document(doc!.id);
    return doc;
  });

  /** Add a document from the library. Project members can then read it through the project. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/sources/link", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const { documentId } = parse(z.object({ documentId: z.string() }), req.body);
    const [doc] = await db
      .select({ id: document.id, name: document.name })
      .from(document)
      .where(and(eq(document.id, documentId), isNull(document.projectId), accessibleDocs(p.workspaceId, u.id)));
    if (!doc) throw notFound("Document not found");
    await addSource(p.id, doc.id, u.id);
    await audit(ctx, { actor: u, action: "project.source_linked", workspaceId: p.workspaceId, targetType: "document", targetId: doc.id, meta: { projectId: p.id } });
    return { ok: true };
  });

  /** Label a source (Confirmed / Assumption / TBD) or mark it superseded by a newer source. */
  app.patch<{ Params: { id: string; documentId: string } }>("/api/projects/:id/sources/:documentId", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const body = parse(sourceUpdateSchema, req.body);
    const inProject = async (docId: string) =>
      (await db.select({ id: projectSource.documentId }).from(projectSource).where(and(eq(projectSource.projectId, p.id), eq(projectSource.documentId, docId))))
        .length > 0;
    if (!(await inProject(req.params.documentId))) throw notFound("Source not found");
    if (body.supersededById) {
      if (body.supersededById === req.params.documentId) throw badRequest("A source can't replace itself.");
      if (!(await inProject(body.supersededById))) throw badRequest("The newer version must be a source of this project.");
    }
    const [updated] = await db
      .update(document)
      .set(body)
      .where(eq(document.id, req.params.documentId))
      .returning({ id: document.id, label: document.label, supersededById: document.supersededById });
    await audit(ctx, { actor: u, action: "project.source_updated", workspaceId: p.workspaceId, targetType: "document", targetId: updated!.id, meta: { projectId: p.id, ...body } });
    return updated;
  });

  /** Remove a source. Project-only sources are deleted; library documents are just unlinked. */
  app.delete<{ Params: { id: string; documentId: string } }>("/api/projects/:id/sources/:documentId", async (req) => {
    const u = await requireUser(ctx, req);
    const { project: p } = await requireProjectEdit(ctx, u, req.params.id);
    const [doc] = await db.select().from(document).where(eq(document.id, req.params.documentId));
    if (!doc) throw notFound("Source not found");
    await db.delete(projectSource).where(and(eq(projectSource.projectId, p.id), eq(projectSource.documentId, doc.id)));
    if (doc.projectId === p.id) {
      await db.delete(document).where(eq(document.id, doc.id));
      await storage.remove(doc.storageKey).catch(() => {});
    }
    await audit(ctx, { actor: u, action: "project.source_removed", workspaceId: p.workspaceId, targetType: "document", targetId: doc.id, meta: { projectId: p.id, name: doc.name } });
    return { ok: true };
  });

  /* ───────────── Search (⌘K) ───────────── */

  app.get<{ Querystring: { workspaceId: string; q: string } }>("/api/search", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.query.workspaceId, "workspace.use");
    const admin = await isWorkspaceAdmin(ctx, u, req.query.workspaceId);
    const q = (req.query.q ?? "").trim().slice(0, 200);
    if (q.length < 2) return { chats: [], documents: [], projects: [] };
    const like = `%${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    const terms = (q.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).slice(0, 12);
    const tsq = terms.length ? sql`to_tsquery('simple', ${terms.map((t) => `${t}:*`).join(" & ")})` : null;

    const readableChat = and(
      eq(chat.workspaceId, req.query.workspaceId),
      eq(chat.temporary, false),
      or(
        eq(chat.userId, u.id),
        and(
          eq(chat.sharedToProject, true),
          sql`exists (select 1 from project p where p.id = ${chat.projectId} and (p.owner_id = ${u.id} or p.visibility = 'workspace' or exists (select 1 from project_member pm where pm.project_id = p.id and pm.user_id = ${u.id})))`,
        ),
      ),
    );
    const titleHits = await db
      .select({ id: chat.id, title: chat.title, projectId: chat.projectId, archived: sql<boolean>`${chat.archivedAt} is not null`, updatedAt: chat.updatedAt })
      .from(chat)
      .where(and(readableChat, sql`${chat.title} ilike ${like}`))
      .orderBy(desc(chat.updatedAt))
      .limit(10);
    const messageHits = tsq
      ? await db
          .select({
            id: chat.id,
            title: chat.title,
            projectId: chat.projectId,
            archived: sql<boolean>`${chat.archivedAt} is not null`,
            updatedAt: chat.updatedAt,
            snippet: message.content,
          })
          .from(message)
          .innerJoin(chat, eq(chat.id, message.chatId))
          .where(and(readableChat, sql`to_tsvector('simple', ${message.content}) @@ ${tsq}`))
          .orderBy(sql`ts_rank_cd(to_tsvector('simple', ${message.content}), ${tsq}) desc`)
          .limit(20)
      : [];
    const chats = new Map<string, { id: string; title: string; projectId: string | null; archived: boolean; updatedAt: Date; snippet: string | null }>();
    for (const c of titleHits) chats.set(c.id, { ...c, snippet: null });
    for (const m of messageHits) {
      if (chats.has(m.id)) continue;
      const lower = m.snippet.toLowerCase();
      const at = Math.max(0, terms.reduce((best, t) => (best >= 0 ? best : lower.indexOf(t)), -1));
      chats.set(m.id, { ...m, snippet: (at > 60 ? "…" : "") + m.snippet.slice(Math.max(0, at - 60), at + 140).replace(/\s+/g, " ").trim() });
    }

    const [documents, projects] = await Promise.all([
      db
        .select({ id: document.id, name: document.name, projectId: document.projectId })
        .from(document)
        .where(and(accessibleDocs(req.query.workspaceId, u.id), sql`${document.name} ilike ${like}`))
        .orderBy(desc(document.createdAt))
        .limit(8),
      db
        .select({ id: project.id, name: project.name, color: project.color })
        .from(project)
        .where(and(eq(project.workspaceId, req.query.workspaceId), projectVisibleTo(u.id, admin), sql`${project.name} ilike ${like}`))
        .limit(8),
    ]);
    const projectNames = new Map(
      (
        await db
          .select({ id: project.id, name: project.name })
          .from(project)
          .where(inArray(project.id, [...new Set([...chats.values()].map((c) => c.projectId).filter(Boolean) as string[]), "-"]))
      ).map((p) => [p.id, p.name]),
    );
    return {
      chats: [...chats.values()].slice(0, 15).map((c) => ({ ...c, projectName: c.projectId ? (projectNames.get(c.projectId) ?? null) : null })),
      documents,
      projects,
    };
  });
}
