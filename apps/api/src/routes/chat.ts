import { and, asc, chat, chatDocument, desc, document, eq, inArray, isNotNull, isNull, message, organization, project, projectSource, usageEvent, user, type DB } from "@aatmiq/db";
import { streamChat, type ChatMessage } from "@aatmiq/model-gateway";
import { chatCreateSchema, chatUpdateSchema, isOrgAdmin, PRODUCT_NAME, sendMessageSchema } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { parse, requireUser, requireWorkspaceCap, type AppContext, type SessionUser } from "../context";
import { badRequest, forbidden, HttpError, notFound } from "../errors";
import { accessibleDocs, buildContext, recallProjectChats, retrieve } from "../services/documents";
import { getProjectAccess } from "../services/projects";
import { resolveModel } from "../services/models";
import { getQuotaStatus } from "../services/quota";

const MAX_HISTORY = 40;

async function loadOwnChat(db: DB, u: SessionUser, chatId: string) {
  const [c] = await db.select().from(chat).where(eq(chat.id, chatId));
  if (!c || c.userId !== u.id) throw notFound("Chat not found");
  return c;
}

/** The author's own chat, or (read-only) a chat shared to a project the user can open. */
async function loadReadableChat(ctx: AppContext, u: SessionUser, chatId: string) {
  const [c] = await ctx.db.select().from(chat).where(eq(chat.id, chatId));
  if (!c) throw notFound("Chat not found");
  if (c.userId === u.id) return { chat: c, readOnly: false };
  if (!c.projectId || !c.sharedToProject) throw notFound("Chat not found");
  await getProjectAccess(ctx, u, c.projectId);
  return { chat: c, readOnly: true };
}

async function requireChatSection(ctx: AppContext, u: SessionUser, workspaceId: string) {
  const m = await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
  if (m && !m.sections.includes("chat") && !isOrgAdmin(u.orgRole)) throw forbidden("Chat is not enabled for you.");
}

/** Give just-uploaded documents a moment to finish processing before answering (max ~30s). */
async function waitForProcessing(db: DB, ids: string[]) {
  if (ids.length === 0) return;
  for (let i = 0; i < 60; i++) {
    const pending = await db
      .select({ id: document.id })
      .from(document)
      .where(and(inArray(document.id, ids), eq(document.status, "processing")));
    if (pending.length === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine || "New chat";
}

export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box } = ctx;

  /**
   * The user's own chats. Default: outside projects and not archived.
   * `projectId`: chats in that project. `archived=1`: every archived chat.
   */
  app.get<{ Querystring: { workspaceId: string; projectId?: string; archived?: string } }>("/api/chats", async (req) => {
    const u = await requireUser(ctx, req);
    await requireChatSection(ctx, u, req.query.workspaceId);
    const archived = req.query.archived === "1" || req.query.archived === "true";
    const scope = archived
      ? isNotNull(chat.archivedAt)
      : and(isNull(chat.archivedAt), req.query.projectId ? eq(chat.projectId, req.query.projectId) : isNull(chat.projectId));
    return db
      .select({
        id: chat.id,
        title: chat.title,
        pinned: chat.pinned,
        modelId: chat.modelId,
        projectId: chat.projectId,
        projectName: project.name,
        sharedToProject: chat.sharedToProject,
        archivedAt: chat.archivedAt,
        updatedAt: chat.updatedAt,
      })
      .from(chat)
      .leftJoin(project, eq(project.id, chat.projectId))
      .where(and(eq(chat.workspaceId, req.query.workspaceId), eq(chat.userId, u.id), scope))
      .orderBy(...(archived ? [desc(chat.archivedAt)] : [desc(chat.pinned), desc(chat.updatedAt)]))
      .limit(200);
  });

  app.post("/api/chats", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(chatCreateSchema, req.body);
    await requireChatSection(ctx, u, body.workspaceId);
    if (body.projectId) {
      const { project: p } = await getProjectAccess(ctx, u, body.projectId);
      if (p.workspaceId !== body.workspaceId) throw badRequest("That project belongs to another workspace.");
    }
    const [c] = await db
      .insert(chat)
      .values({ workspaceId: body.workspaceId, userId: u.id, title: body.title ?? "New chat", modelId: body.modelId, projectId: body.projectId })
      .returning();
    return c;
  });

  app.get<{ Params: { id: string } }>("/api/chats/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const { chat: c, readOnly } = await loadReadableChat(ctx, u, req.params.id);
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.chatId, c.id))
      .orderBy(asc(message.createdAt));
    const documents = await db
      .select({ id: document.id, name: document.name, status: document.status })
      .from(chatDocument)
      .innerJoin(document, eq(document.id, chatDocument.documentId))
      .where(eq(chatDocument.chatId, c.id))
      .orderBy(asc(chatDocument.createdAt));
    const [proj] = c.projectId
      ? await db.select({ id: project.id, name: project.name, color: project.color }).from(project).where(eq(project.id, c.projectId))
      : [];
    const [author] = readOnly ? await db.select({ name: user.name }).from(user).where(eq(user.id, c.userId)) : [];
    return { ...c, messages, documents, readOnly, project: proj ?? null, authorName: author?.name ?? null };
  });

  app.patch<{ Params: { id: string } }>("/api/chats/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const c = await loadOwnChat(db, u, req.params.id);
    const { archived, projectId, sharedToProject, ...rest } = parse(chatUpdateSchema, req.body);
    const set: Partial<typeof chat.$inferInsert> = { ...rest };
    if (archived !== undefined) set.archivedAt = archived ? new Date() : null;
    if (projectId !== undefined) {
      if (projectId) {
        const { project: p } = await getProjectAccess(ctx, u, projectId);
        if (p.workspaceId !== c.workspaceId) throw badRequest("That project belongs to another workspace.");
      }
      set.projectId = projectId;
      // A chat moved elsewhere stops being shared with the old project.
      if (projectId !== c.projectId) set.sharedToProject = false;
    }
    if (sharedToProject !== undefined) {
      if (sharedToProject && !(set.projectId ?? c.projectId)) throw badRequest("Only chats inside a project can be shared to it.");
      set.sharedToProject = sharedToProject;
    }
    const [updated] = await db.update(chat).set(set).where(eq(chat.id, c.id)).returning();
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/api/chats/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const c = await loadOwnChat(db, u, req.params.id);
    await db.delete(chat).where(eq(chat.id, c.id));
    return { ok: true };
  });

  /**
   * Send a message and stream the reply as server-sent events:
   *   event: start  {userMessageId, model, citations}
   *   event: delta  {text}
   *   event: done   {messageId, usage, quota}
   *   event: error  {message}
   */
  app.post<{ Params: { id: string } }>("/api/chats/:id/messages", async (req, reply) => {
    const u = await requireUser(ctx, req);
    const c = await loadOwnChat(db, u, req.params.id);
    await requireChatSection(ctx, u, c.workspaceId);
    const body = parse(sendMessageSchema, req.body);

    const quota = await getQuotaStatus(db, c.workspaceId, u.id);
    if (!quota.result.allowed) {
      throw new HttpError(402, "You've used your token allowance for this period.", "quota_exceeded", quota);
    }

    const { model: m, provider } = await resolveModel(db, box, c.workspaceId, "chat", body.modelId ?? c.modelId);

    // Attach any newly referenced documents to the chat (only ones this user may read).
    let attachments: { id: string; name: string }[] = [];
    if (body.documentIds?.length) {
      attachments = await db
        .select({ id: document.id, name: document.name })
        .from(document)
        .where(and(accessibleDocs(c.workspaceId, u.id), inArray(document.id, body.documentIds)));
      if (attachments.length !== new Set(body.documentIds).size) throw badRequest("Some attached documents aren't available.");
      await db
        .insert(chatDocument)
        .values(attachments.map((a) => ({ chatId: c.id, documentId: a.id })))
        .onConflictDoNothing();
    }
    const chatDocIds = (
      await db.select({ id: chatDocument.documentId }).from(chatDocument).where(eq(chatDocument.chatId, c.id))
    ).map((r) => r.id);

    // Inside a project, its sources are always in reach. If access was revoked, the chat carries on without them.
    const proj = c.projectId ? await getProjectAccess(ctx, u, c.projectId).then((a) => a.project, () => null) : null;
    const projectDocIds = proj
      ? (await db.select({ id: projectSource.documentId }).from(projectSource).where(eq(projectSource.projectId, proj.id))).map((r) => r.id)
      : [];
    await waitForProcessing(db, [...chatDocIds, ...projectDocIds]);

    const history = await db
      .select({ role: message.role, content: message.content, error: message.error })
      .from(message)
      .where(eq(message.chatId, c.id))
      .orderBy(desc(message.createdAt))
      .limit(MAX_HISTORY);

    const [userMsg] = await db
      .insert(message)
      .values({ chatId: c.id, role: "user", content: body.content, attachments: attachments.length ? attachments : null })
      .returning({ id: message.id });

    const [[org], [profile]] = await Promise.all([
      db.select({ productName: organization.productName, promptLogging: organization.promptLogging }).from(organization).limit(1),
      db.select({ ci: user.customInstructions, name: user.name }).from(user).where(eq(user.id, u.id)),
    ]);
    const product = org?.productName ?? PRODUCT_NAME;
    // Project instructions take precedence over the user's personal ones.
    const instructions = proj?.instructions?.trim()
      ? `\nThis chat is in the project "${proj.name}". Follow the project's instructions (they take precedence over the user's personal ones):\n${proj.instructions.trim()}`
      : profile?.ci
        ? `\nThe user's custom instructions:\n${profile.ci}`
        : "";
    const system = [
      `You are ${product}, a helpful private AI assistant for ${u.name}'s organization.`,
      `Answer clearly and concisely. Use Markdown for structure and fenced code blocks for code.`,
      proj && !proj.instructions?.trim() ? `\nThis chat is in the project "${proj.name}".` : "",
      instructions,
    ].join("\n");

    const [retrieval, recollections] = await Promise.all([
      retrieve(db, box, {
        workspaceId: c.workspaceId,
        userId: u.id,
        documentIds: [...new Set([...chatDocIds, ...projectDocIds])],
        query: body.content,
      }),
      proj ? recallProjectChats(db, { projectId: proj.id, chatId: c.id, userId: u.id, query: body.content }) : [],
    ]);
    const docContext = buildContext(retrieval.chunks, recollections);
    if (retrieval.embedTokens > 0) {
      await db.insert(usageEvent).values({
        workspaceId: c.workspaceId,
        userId: u.id,
        modelId: retrieval.embeddingModelId,
        section: "chat",
        inputTokens: retrieval.embedTokens,
        outputTokens: 0,
      });
    }

    const messages: ChatMessage[] = [
      { role: "system", content: docContext.system ? `${system}\n\n${docContext.system}` : system },
      ...history
        .reverse()
        .filter((h) => !h.error && h.role !== "system")
        .map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: body.content },
    ];

    const titleUpdate = c.title === "New chat" ? { title: titleFrom(body.content) } : {};
    await db.update(chat).set({ ...titleUpdate, modelId: m.id, updatedAt: new Date() }).where(eq(chat.id, c.id));
    if (proj) await db.update(project).set({ updatedAt: new Date() }).where(eq(project.id, proj.id));

    // Stream.
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    const abort = new AbortController();
    res.on("close", () => abort.abort());

    send("start", {
      userMessageId: userMsg!.id,
      model: { id: m.id, displayName: m.displayName },
      citations: docContext.citations,
      ...titleUpdate,
    });

    const started = Date.now();
    let text = "";
    let error: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, estimated: true };
    try {
      for await (const ev of streamChat(provider, m.modelKey, messages, { signal: abort.signal })) {
        if (ev.type === "delta") {
          text += ev.text;
          send("delta", { text: ev.text });
        } else {
          usage = ev.usage;
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) error = e instanceof Error ? e.message : "The model failed to respond.";
    }
    if (abort.signal.aborted && usage.outputTokens === 0) {
      usage = { inputTokens: messages.reduce((n, x) => n + Math.ceil(x.content.length / 4), 0), outputTokens: Math.ceil(text.length / 4), estimated: true };
    }

    const [assistant] = await db
      .insert(message)
      .values({
        chatId: c.id,
        role: "assistant",
        content: text,
        modelId: m.id,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        error,
        citations: docContext.citations.length ? docContext.citations : null,
      })
      .returning({ id: message.id });
    await db.insert(usageEvent).values({
      workspaceId: c.workspaceId,
      userId: u.id,
      modelId: m.id,
      section: "chat",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      estimated: usage.estimated,
      latencyMs: Date.now() - started,
      status: error ? "error" : abort.signal.aborted ? "aborted" : "ok",
    });

    if (!res.writableEnded && !res.destroyed) {
      if (error) send("error", { message: error, messageId: assistant!.id });
      else send("done", { messageId: assistant!.id, usage, quota: await getQuotaStatus(db, c.workspaceId, u.id) });
      res.end();
    }
  });
}
