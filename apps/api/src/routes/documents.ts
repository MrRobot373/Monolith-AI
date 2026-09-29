import { and, desc, document, eq, isNull, user, type DB } from "@aatmiq/db";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, parse, requireUser, requireWorkspaceCap, type AppContext, type SessionUser } from "../context";
import { randomToken } from "../crypto";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { accessibleDocs, processDocument } from "../services/documents";
import { getProjectAccess } from "../services/projects";
import { isSupported, SUPPORTED_HINT } from "../services/extract";

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const updateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  scope: z.enum(["private", "workspace"]).optional(),
});

export async function loadReadable(ctx: AppContext, u: SessionUser, id: string) {
  const [doc] = await ctx.db.select().from(document).where(eq(document.id, id));
  if (!doc) throw notFound("Document not found");
  const m = await requireWorkspaceCap(ctx, u, doc.workspaceId, "workspace.use");
  const isAdmin = u.orgRole !== "member" || m?.role === "admin";
  if (doc.projectId) {
    const a = await getProjectAccess(ctx, u, doc.projectId).catch(() => null);
    if (!a) throw notFound("Document not found");
    return { doc, canManage: a.canEdit || doc.ownerId === u.id };
  }
  if (doc.scope === "private" && doc.ownerId !== u.id && !isAdmin) {
    const [ok] = await ctx.db.select({ id: document.id }).from(document).where(and(eq(document.id, id), accessibleDocs(doc.workspaceId, u.id)));
    if (!ok) throw notFound("Document not found");
    return { doc, canManage: false };
  }
  return { doc, canManage: doc.ownerId === u.id || isAdmin };
}

export function listDocuments(db: DB, workspaceId: string, userId: string) {
  return db
    .select({
      id: document.id,
      name: document.name,
      mimeType: document.mimeType,
      sizeBytes: document.sizeBytes,
      scope: document.scope,
      status: document.status,
      error: document.error,
      pageCount: document.pageCount,
      chunkCount: document.chunkCount,
      ownerId: document.ownerId,
      ownerName: user.name,
      createdAt: document.createdAt,
    })
    .from(document)
    .leftJoin(user, eq(user.id, document.ownerId))
    .where(and(accessibleDocs(workspaceId, userId), isNull(document.projectId)))
    .orderBy(desc(document.createdAt))
    .limit(500);
}

export async function documentRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box, storage } = ctx;

  app.get<{ Querystring: { workspaceId: string } }>("/api/documents", async (req) => {
    const u = await requireUser(ctx, req);
    await requireWorkspaceCap(ctx, u, req.query.workspaceId, "workspace.use");
    return listDocuments(db, req.query.workspaceId, u.id);
  });

  /** Multipart upload: fields `workspaceId`, optional `scope`, then one `file`. Processing runs in the background. */
  app.post("/api/documents", async (req) => {
    const u = await requireUser(ctx, req);
    if (!req.isMultipart()) throw badRequest("Send the file as multipart/form-data");
    const fields: Record<string, string> = {};
    let file: { name: string; mime: string; data: Buffer } | null = null;
    for await (const part of req.parts({ limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } })) {
      if (part.type === "field") fields[part.fieldname] = String(part.value);
      else {
        const data = await part.toBuffer();
        if (part.file.truncated) throw new HttpError(413, "Files can be up to 25 MB.", "too_large");
        file = { name: part.filename, mime: part.mimetype || "application/octet-stream", data };
      }
    }
    if (!file) throw badRequest("No file was uploaded");
    const workspaceId = fields.workspaceId ?? "";
    await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
    const name = file.name.replace(/[\\/]/g, "_").slice(0, 200) || "Untitled";
    if (!isSupported(name)) throw new HttpError(415, `This file type isn't supported yet. Upload ${SUPPORTED_HINT}.`, "unsupported");
    if (file.data.length === 0) throw badRequest("The file is empty");

    const storageKey = `${workspaceId}/${randomToken(18)}`;
    await storage.put(storageKey, file.data);
    const [doc] = await db
      .insert(document)
      .values({
        workspaceId,
        ownerId: u.id,
        name,
        mimeType: file.mime,
        sizeBytes: file.data.length,
        storageKey,
        scope: fields.scope === "workspace" ? "workspace" : "private",
      })
      .returning();
    await audit(ctx, { actor: u, action: "document.uploaded", workspaceId, targetType: "document", targetId: doc!.id, meta: { name, size: file.data.length } });
    setImmediate(() => void processDocument(db, box, storage, doc!.id));
    return { ...doc, ownerName: u.name };
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { doc, canManage } = await loadReadable(ctx, u, req.params.id);
    const { storageKey: _k, ...rest } = doc;
    return { ...rest, canManage };
  });

  app.get<{ Params: { id: string } }>("/api/documents/:id/file", async (req, reply) => {
    const u = await requireUser(ctx, req);
    const { doc } = await loadReadable(ctx, u, req.params.id);
    const data = await storage.get(doc.storageKey);
    reply.header("content-type", doc.mimeType);
    reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(doc.name)}`);
    reply.header("x-content-type-options", "nosniff");
    return reply.send(data);
  });

  app.patch<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { doc, canManage } = await loadReadable(ctx, u, req.params.id);
    if (!canManage) throw forbidden("Only the owner or a workspace admin can change this document.");
    const body = parse(updateSchema, req.body);
    const [updated] = await db.update(document).set(body).where(eq(document.id, doc.id)).returning();
    if (body.scope && body.scope !== doc.scope)
      await audit(ctx, { actor: u, action: body.scope === "workspace" ? "document.shared" : "document.unshared", workspaceId: doc.workspaceId, targetType: "document", targetId: doc.id });
    const { storageKey: _k, ...rest } = updated!;
    return rest;
  });

  app.post<{ Params: { id: string } }>("/api/documents/:id/reprocess", async (req) => {
    const u = await requireUser(ctx, req);
    const { doc, canManage } = await loadReadable(ctx, u, req.params.id);
    if (!canManage) throw forbidden();
    await db.update(document).set({ status: "processing", error: null }).where(eq(document.id, doc.id));
    setImmediate(() => void processDocument(db, box, storage, doc.id));
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>("/api/documents/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { doc, canManage } = await loadReadable(ctx, u, req.params.id);
    if (!canManage) throw forbidden("Only the owner or a workspace admin can delete this document.");
    await db.delete(document).where(and(eq(document.id, doc.id)));
    await storage.remove(doc.storageKey).catch(() => {});
    await audit(ctx, { actor: u, action: "document.deleted", workspaceId: doc.workspaceId, targetType: "document", targetId: doc.id, meta: { name: doc.name } });
    return { ok: true };
  });
}
