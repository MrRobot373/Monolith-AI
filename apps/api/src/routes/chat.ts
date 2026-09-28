import { and, asc, chat, desc, eq, message, organization, usageEvent, user, type DB } from "@aatmiq/db";
import { streamChat, type ChatMessage } from "@aatmiq/model-gateway";
import { chatCreateSchema, chatUpdateSchema, isOrgAdmin, PRODUCT_NAME, sendMessageSchema } from "@aatmiq/shared";
import type { FastifyInstance } from "fastify";
import { parse, requireUser, requireWorkspaceCap, type AppContext, type SessionUser } from "../context";
import { forbidden, HttpError, notFound } from "../errors";
import { resolveModel } from "../services/models";
import { getQuotaStatus } from "../services/quota";

const MAX_HISTORY = 40;

async function loadOwnChat(db: DB, u: SessionUser, chatId: string) {
  const [c] = await db.select().from(chat).where(eq(chat.id, chatId));
  if (!c || c.userId !== u.id) throw notFound("Chat not found");
  return c;
}

async function requireChatSection(ctx: AppContext, u: SessionUser, workspaceId: string) {
  const m = await requireWorkspaceCap(ctx, u, workspaceId, "workspace.use");
  if (m && !m.sections.includes("chat") && !isOrgAdmin(u.orgRole)) throw forbidden("Chat is not enabled for you.");
}

function titleFrom(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57).trimEnd()}…` : oneLine || "New chat";
}

export async function chatRoutes(app: FastifyInstance, ctx: AppContext) {
  const { db, box } = ctx;

  app.get<{ Querystring: { workspaceId: string } }>("/api/chats", async (req) => {
    const u = await requireUser(ctx, req);
    await requireChatSection(ctx, u, req.query.workspaceId);
    return db
      .select({ id: chat.id, title: chat.title, pinned: chat.pinned, modelId: chat.modelId, updatedAt: chat.updatedAt })
      .from(chat)
      .where(and(eq(chat.workspaceId, req.query.workspaceId), eq(chat.userId, u.id)))
      .orderBy(desc(chat.pinned), desc(chat.updatedAt))
      .limit(200);
  });

  app.post("/api/chats", async (req) => {
    const u = await requireUser(ctx, req);
    const body = parse(chatCreateSchema, req.body);
    await requireChatSection(ctx, u, body.workspaceId);
    const [c] = await db
      .insert(chat)
      .values({ workspaceId: body.workspaceId, userId: u.id, title: body.title ?? "New chat", modelId: body.modelId })
      .returning();
    return c;
  });

  app.get<{ Params: { id: string } }>("/api/chats/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const c = await loadOwnChat(db, u, req.params.id);
    const messages = await db
      .select()
      .from(message)
      .where(eq(message.chatId, c.id))
      .orderBy(asc(message.createdAt));
    return { ...c, messages };
  });

  app.patch<{ Params: { id: string } }>("/api/chats/:id", async (req) => {
    const u = await requireUser(ctx, req);
    const c = await loadOwnChat(db, u, req.params.id);
    const body = parse(chatUpdateSchema, req.body);
    const [updated] = await db.update(chat).set(body).where(eq(chat.id, c.id)).returning();
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
   *   event: start  {userMessageId, model}
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

    const history = await db
      .select({ role: message.role, content: message.content, error: message.error })
      .from(message)
      .where(eq(message.chatId, c.id))
      .orderBy(desc(message.createdAt))
      .limit(MAX_HISTORY);

    const [userMsg] = await db
      .insert(message)
      .values({ chatId: c.id, role: "user", content: body.content })
      .returning({ id: message.id });

    const [[org], [profile]] = await Promise.all([
      db.select({ productName: organization.productName, promptLogging: organization.promptLogging }).from(organization).limit(1),
      db.select({ ci: user.customInstructions, name: user.name }).from(user).where(eq(user.id, u.id)),
    ]);
    const product = org?.productName ?? PRODUCT_NAME;
    const system = [
      `You are ${product}, a helpful private AI assistant for ${u.name}'s organization.`,
      `Answer clearly and concisely. Use Markdown for structure and fenced code blocks for code.`,
      profile?.ci ? `\nThe user's custom instructions:\n${profile.ci}` : "",
    ].join("\n");

    const messages: ChatMessage[] = [
      { role: "system", content: system },
      ...history
        .reverse()
        .filter((h) => !h.error && h.role !== "system")
        .map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: body.content },
    ];

    const titleUpdate = c.title === "New chat" ? { title: titleFrom(body.content) } : {};
    await db.update(chat).set({ ...titleUpdate, modelId: m.id, updatedAt: new Date() }).where(eq(chat.id, c.id));

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

    send("start", { userMessageId: userMsg!.id, model: { id: m.id, displayName: m.displayName }, ...titleUpdate });

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
