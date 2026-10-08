/**
 * Document ingestion (extract → chunk → embed) and retrieval (keyword + vector, fused).
 * See docs/02-chat.md. Keyword search always works; vectors are added when the
 * workspace has an embedding model.
 */
import {
  and,
  asc,
  chat,
  document,
  documentChunk,
  eq,
  inArray,
  isNull,
  message,
  model,
  modelProvider,
  ne,
  or,
  sql,
  usageEvent,
  workspace,
  type Citation,
  type DB,
} from "@aatmiq/db";
import { embed, type ProviderConfig } from "@aatmiq/model-gateway";
import type { SecretBox } from "../crypto";
import { chunkPages, extractText, UnsupportedFileError } from "./extract";
import { docInAccessibleProject } from "./projects";
import type { Storage } from "./storage";

const EMBED_BATCH = 32;
/** Attached documents at or under this size are given to the model in full. */
const WHOLE_DOC_CHARS = 14_000;

export async function embeddingModelFor(db: DB, box: SecretBox, workspaceId: string) {
  const [row] = await db
    .select({ model, provider: modelProvider })
    .from(workspace)
    .innerJoin(model, eq(model.id, workspace.embeddingModelId))
    .innerJoin(modelProvider, eq(modelProvider.id, model.providerId))
    .where(and(eq(workspace.id, workspaceId), eq(model.enabled, true), eq(model.kind, "embedding")));
  if (!row) return null;
  const cfg: ProviderConfig = {
    id: row.provider.id,
    type: row.provider.type,
    baseUrl: row.provider.baseUrl,
    apiKey: row.provider.apiKeyEnc ? box.decrypt(row.provider.apiKeyEnc) : null,
  };
  return { id: row.model.id, key: row.model.modelKey, cfg, queryPrefix: row.model.queryPrefix ?? "", documentPrefix: row.model.documentPrefix ?? "" };
}

/** A document passage as the embedding model expects it (its title is the file name, without the extension). */
export function forEmbedding(prefix: string, name: string, text: string): string {
  if (!prefix) return text;
  const title = name.replace(/\.[a-z0-9]{1,6}$/i, "").replace(/[|\n]+/g, " ").trim() || "none";
  return prefix.replaceAll("{title}", title) + text;
}

/** Raised for files that will never work (no text, unsupported type): retrying can't help. */
class NoTextError extends Error {}

/**
 * Extract, chunk and (optionally) embed a stored document. Never throws; records the outcome on the
 * row. With `willRetry`, a failure that may pass (storage or the embedding model unreachable) leaves
 * the document "processing" and returns "retry" so the job queue can try again later.
 */
export async function processDocument(
  db: DB,
  box: SecretBox,
  storage: Storage,
  documentId: string,
  opts: { willRetry?: boolean } = {},
): Promise<"ready" | "failed" | "retry" | "missing"> {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId));
  if (!doc) return "missing";
  try {
    const data = await storage.get(doc.storageKey);
    const pages = await extractText(doc.name, data);
    const chunks = chunkPages(pages);
    const charCount = pages.reduce((n, p) => n + p.text.length, 0);
    if (chunks.length === 0) throw new NoTextError("No readable text was found. Scanned PDFs need OCR, which is coming soon.");

    const emb = await embeddingModelFor(db, box, doc.workspaceId);
    let vectors: (number[] | null)[] = chunks.map(() => null);
    if (emb) {
      let tokens = 0;
      vectors = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const r = await embed(emb.cfg, emb.key, chunks.slice(i, i + EMBED_BATCH).map((c) => forEmbedding(emb.documentPrefix, doc.name, c.content)));
        vectors.push(...r.vectors);
        tokens += r.inputTokens;
      }
      await db.insert(usageEvent).values({
        workspaceId: doc.workspaceId,
        userId: doc.ownerId,
        modelId: emb.id,
        section: "system",
        inputTokens: tokens,
        outputTokens: 0,
      });
    }

    await db.transaction(async (tx) => {
      await tx.delete(documentChunk).where(eq(documentChunk.documentId, doc.id));
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.insert(documentChunk).values(
          chunks.slice(i, i + 200).map((c, j) => ({
            documentId: doc.id,
            workspaceId: doc.workspaceId,
            ordinal: c.ordinal,
            page: c.page,
            content: c.content,
            embedding: vectors[i + j] ?? null,
          })),
        );
      }
      await tx
        .update(document)
        .set({
          status: "ready",
          error: null,
          chunkCount: chunks.length,
          charCount,
          pageCount: pages.some((p) => p.page !== null) ? pages.length : null,
          embeddingModelId: emb?.id ?? null,
        })
        .where(eq(document.id, doc.id));
    });
    return "ready";
  } catch (e) {
    const message =
      e instanceof UnsupportedFileError || e instanceof Error ? e.message : "The file could not be processed.";
    const permanent = e instanceof UnsupportedFileError || e instanceof NoTextError;
    if (opts.willRetry && !permanent) {
      await db.update(document).set({ status: "processing", error: `Will try again: ${message}`.slice(0, 500) }).where(eq(document.id, doc.id));
      return "retry";
    }
    await db.update(document).set({ status: "failed", error: message.slice(0, 500) }).where(eq(document.id, doc.id));
    return "failed";
  }
}

/** Documents a user may read in a workspace: their own, workspace-shared ones, and sources of projects they can open. */
export function accessibleDocs(workspaceId: string, userId: string) {
  return and(
    eq(document.workspaceId, workspaceId),
    or(
      and(isNull(document.projectId), or(eq(document.scope, "workspace"), eq(document.ownerId, userId))),
      docInAccessibleProject(sql.raw(`"document"."id"`), userId),
    ),
  );
}

export interface Recollection {
  chatId: string;
  title: string;
  content: string;
}

/**
 * Project-only memory: relevant messages from the user's other chats in the same project
 * (plus chats teammates shared to it). Never looks outside the project.
 */
export async function recallProjectChats(
  db: DB,
  opts: { projectId: string; chatId: string; userId: string; query: string; k?: number },
): Promise<Recollection[]> {
  const q = toTsQuery(opts.query);
  if (!q) return [];
  const tsq = sql`to_tsquery('simple', ${q})`;
  const rows = await db
    .select({ chatId: chat.id, title: chat.title, content: message.content })
    .from(message)
    .innerJoin(chat, eq(chat.id, message.chatId))
    .where(
      and(
        eq(chat.projectId, opts.projectId),
        ne(chat.id, opts.chatId),
        isNull(chat.archivedAt),
        eq(chat.temporary, false),
        or(eq(chat.userId, opts.userId), eq(chat.sharedToProject, true)),
        isNull(message.error),
        sql`to_tsvector('simple', ${message.content}) @@ ${tsq}`,
      ),
    )
    .orderBy(sql`ts_rank_cd(to_tsvector('simple', ${message.content}), ${tsq}) desc`)
    .limit((opts.k ?? 3) * 2);
  const seen = new Set<string>();
  return rows
    .filter((r) => (seen.has(r.chatId) ? false : (seen.add(r.chatId), true)))
    .slice(0, opts.k ?? 3)
    .map((r) => ({ ...r, content: r.content.slice(0, 900) }));
}

const STOPWORDS = new Set(
  "a an and are as at be but by can could did do does for from had has have how i in is it its me my of on or our so than that the their them there these they this to was we were what when where which who why will with would you your about into please tell give show list".split(
    " ",
  ),
);

export function toTsQuery(text: string): string | null {
  const words = (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 24);
  return unique.length ? unique.map((w) => `${w}:*`).join(" | ") : null;
}

export interface RetrievedChunk {
  id: string;
  documentId: string;
  name: string;
  page: number | null;
  content: string;
  ordinal: number;
  label?: "confirmed" | "assumption" | "tbd" | null;
}

const LABEL_TEXT = { confirmed: "Confirmed", assumption: "Assumption, not confirmed", tbd: "To be decided" } as const;

/**
 * Find the most relevant chunks. Small attached documents are returned whole (in order),
 * so "summarize this" works; otherwise keyword and vector rankings are fused (RRF).
 */
export async function retrieve(
  db: DB,
  box: SecretBox,
  /** Without documentIds: everything the person can open in the workspace, always ranked (the agent's search). */
  opts: { workspaceId: string; userId: string; documentIds?: string[]; query: string; k?: number },
): Promise<{ chunks: RetrievedChunk[]; embedTokens: number; embeddingModelId: string | null }> {
  const k = opts.k ?? 6;
  const library = opts.documentIds === undefined;
  if (opts.documentIds?.length === 0) return { chunks: [], embedTokens: 0, embeddingModelId: null };
  const access = and(
    accessibleDocs(opts.workspaceId, opts.userId),
    eq(document.status, "ready"),
    library ? undefined : inArray(document.id, opts.documentIds!),
    // Older versions that were replaced by a newer upload are left out.
    isNull(document.supersededById),
  );
  const cols = {
    id: documentChunk.id,
    documentId: documentChunk.documentId,
    name: document.name,
    page: documentChunk.page,
    content: documentChunk.content,
    ordinal: documentChunk.ordinal,
    label: document.label,
  };

  const docs = await db.select({ id: document.id, chars: document.charCount }).from(document).where(access);
  if (docs.length === 0) return { chunks: [], embedTokens: 0, embeddingModelId: null };
  const total = docs.reduce((n, d) => n + (d.chars ?? 0), 0);
  if (!library && total <= WHOLE_DOC_CHARS) {
    const all = await db
      .select(cols)
      .from(documentChunk)
      .innerJoin(document, eq(document.id, documentChunk.documentId))
      .where(access)
      .orderBy(asc(document.createdAt), asc(documentChunk.ordinal));
    return { chunks: dedupeOverlap(all), embedTokens: 0, embeddingModelId: null };
  }

  const ranked = new Map<string, { chunk: RetrievedChunk; score: number }>();
  const add = (rows: RetrievedChunk[]) =>
    rows.forEach((c, rank) => {
      const prev = ranked.get(c.id);
      ranked.set(c.id, { chunk: c, score: (prev?.score ?? 0) + 1 / (60 + rank) });
    });

  const q = toTsQuery(opts.query);
  if (q) {
    const tsq = sql`to_tsquery('simple', ${q})`;
    add(
      await db
        .select(cols)
        .from(documentChunk)
        .innerJoin(document, eq(document.id, documentChunk.documentId))
        .where(and(access, sql`${documentChunk.tsv} @@ ${tsq}`))
        .orderBy(sql`ts_rank_cd(${documentChunk.tsv}, ${tsq}) desc`)
        .limit(k * 2),
    );
  }

  let embedTokens = 0;
  const emb = await embeddingModelFor(db, box, opts.workspaceId);
  if (emb) {
    try {
      const r = await embed(emb.cfg, emb.key, [emb.queryPrefix + opts.query]);
      embedTokens = r.inputTokens;
      const vec = `[${r.vectors[0]!.join(",")}]`;
      add(
        await db
          .select(cols)
          .from(documentChunk)
          .innerJoin(document, eq(document.id, documentChunk.documentId))
          .where(and(access, eq(document.embeddingModelId, emb.id), sql`${documentChunk.embedding} is not null`))
          .orderBy(sql`${documentChunk.embedding} <=> ${vec}::vector`)
          .limit(k * 2),
      );
    } catch {
      // Keyword results still stand if the embedding server is down.
    }
  }

  let chunks = [...ranked.values()].sort((a, b) => b.score - a.score).slice(0, k).map((r) => r.chunk);
  if (chunks.length === 0 && !library) {
    // Nothing matched (e.g. "summarize this"): fall back to the opening of each document.
    chunks = await db
      .select(cols)
      .from(documentChunk)
      .innerJoin(document, eq(document.id, documentChunk.documentId))
      .where(and(access, sql`${documentChunk.ordinal} < 2`))
      .orderBy(asc(document.createdAt), asc(documentChunk.ordinal))
      .limit(k);
  }
  return { chunks, embedTokens, embeddingModelId: emb?.id ?? null };
}

/** Consecutive chunks share overlap; trim it so whole-document context isn't repeated. */
function dedupeOverlap(chunks: RetrievedChunk[]): RetrievedChunk[] {
  return chunks.map((c, i) => {
    const prev = chunks[i - 1];
    if (!prev || prev.documentId !== c.documentId) return c;
    for (let len = Math.min(260, c.content.length); len > 20; len--) {
      if (prev.content.endsWith(c.content.slice(0, len))) return { ...c, content: c.content.slice(len).trimStart() };
    }
    return c;
  });
}

/** Number sources for the model and for the UI: document excerpts first, then earlier project chats. */
export function buildContext(chunks: RetrievedChunk[], recollections: Recollection[] = []): { system: string; citations: Citation[] } {
  if (chunks.length === 0 && recollections.length === 0) return { system: "", citations: [] };
  const citations: Citation[] = [
    ...chunks.map((c, i) => ({
      n: i + 1,
      kind: "document" as const,
      documentId: c.documentId,
      name: c.name,
      page: c.page,
      snippet: c.content.slice(0, 700),
      label: c.label ?? null,
    })),
    ...recollections.map((r, i) => ({
      n: chunks.length + i + 1,
      kind: "chat" as const,
      documentId: null,
      chatId: r.chatId,
      name: r.title,
      page: null,
      snippet: r.content.slice(0, 700),
    })),
  ];
  const blocks = [
    ...chunks.map((c, i) => `[${i + 1}] ${c.name}${c.page ? `, page ${c.page}` : ""}${c.label ? ` (${LABEL_TEXT[c.label]})` : ""}\n${c.content}`),
    ...recollections.map((r, i) => `[${chunks.length + i + 1}] Earlier chat in this project: "${r.title}"\n${r.content}`),
  ].join("\n\n---\n\n");
  const system = [
    "Relevant sources are below, numbered: excerpts from documents and, where marked, from earlier chats in this project.",
    "Answer using these excerpts. Cite sources inline with their number in square brackets, like [1] or [2][3], right after the claim they support.",
    "If the excerpts don't contain the answer, say so plainly instead of guessing.",
    ...(chunks.some((c) => c.label === "assumption" || c.label === "tbd")
      ? ["Some sources are marked as an assumption or still to be decided. When you rely on one, say that it isn't confirmed yet."]
      : []),
    "",
    "<sources>",
    blocks,
    "</sources>",
  ].join("\n");
  return { system, citations };
}

/** A document's text for reading, from its chunks in order (overlap removed), if the person can open it. */
export async function documentText(db: DB, workspaceId: string, userId: string, documentId: string) {
  const [doc] = await db
    .select({ id: document.id, name: document.name, status: document.status, label: document.label, pageCount: document.pageCount })
    .from(document)
    .where(and(eq(document.id, documentId), accessibleDocs(workspaceId, userId)));
  if (!doc) return null;
  const chunks = await db
    .select({ id: documentChunk.id, documentId: documentChunk.documentId, name: sql<string>`''`, page: documentChunk.page, content: documentChunk.content, ordinal: documentChunk.ordinal })
    .from(documentChunk)
    .where(eq(documentChunk.documentId, doc.id))
    .orderBy(asc(documentChunk.ordinal));
  const parts: string[] = [];
  let page: number | null = null;
  for (const c of dedupeOverlap(chunks)) {
    if (c.page !== null && c.page !== page) {
      page = c.page;
      parts.push(`\n[page ${page}]\n`);
    }
    parts.push(c.content);
  }
  return { ...doc, text: parts.join("\n").replace(/\n{3,}/g, "\n\n").trim() };
}
