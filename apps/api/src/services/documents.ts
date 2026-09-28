/**
 * Document ingestion (extract → chunk → embed) and retrieval (keyword + vector, fused).
 * See docs/02-chat.md. Keyword search always works; vectors are added when the
 * workspace has an embedding model.
 */
import {
  and,
  asc,
  document,
  documentChunk,
  eq,
  inArray,
  model,
  modelProvider,
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
    type: row.provider.type,
    baseUrl: row.provider.baseUrl,
    apiKey: row.provider.apiKeyEnc ? box.decrypt(row.provider.apiKeyEnc) : null,
  };
  return { id: row.model.id, key: row.model.modelKey, cfg };
}

/** Extract, chunk and (optionally) embed a stored document. Never throws; records failures on the row. */
export async function processDocument(db: DB, box: SecretBox, storage: Storage, documentId: string): Promise<void> {
  const [doc] = await db.select().from(document).where(eq(document.id, documentId));
  if (!doc) return;
  try {
    const data = await storage.get(doc.storageKey);
    const pages = await extractText(doc.name, data);
    const chunks = chunkPages(pages);
    const charCount = pages.reduce((n, p) => n + p.text.length, 0);
    if (chunks.length === 0) throw new Error("No readable text was found. Scanned PDFs need OCR, which is coming soon.");

    const emb = await embeddingModelFor(db, box, doc.workspaceId);
    let vectors: (number[] | null)[] = chunks.map(() => null);
    if (emb) {
      let tokens = 0;
      vectors = [];
      for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
        const r = await embed(emb.cfg, emb.key, chunks.slice(i, i + EMBED_BATCH).map((c) => c.content));
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
  } catch (e) {
    const message =
      e instanceof UnsupportedFileError || e instanceof Error ? e.message : "The file could not be processed.";
    await db.update(document).set({ status: "failed", error: message.slice(0, 500) }).where(eq(document.id, doc.id));
  }
}

/** Documents a user may read in a workspace: their own plus shared ones. */
export function accessibleDocs(workspaceId: string, userId: string) {
  return and(
    eq(document.workspaceId, workspaceId),
    or(eq(document.scope, "workspace"), eq(document.ownerId, userId)),
  );
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
}

/**
 * Find the most relevant chunks. Small attached documents are returned whole (in order),
 * so "summarize this" works; otherwise keyword and vector rankings are fused (RRF).
 */
export async function retrieve(
  db: DB,
  box: SecretBox,
  opts: { workspaceId: string; userId: string; documentIds: string[]; query: string; k?: number },
): Promise<{ chunks: RetrievedChunk[]; embedTokens: number; embeddingModelId: string | null }> {
  const k = opts.k ?? 6;
  if (opts.documentIds.length === 0) return { chunks: [], embedTokens: 0, embeddingModelId: null };
  const access = and(
    accessibleDocs(opts.workspaceId, opts.userId),
    eq(document.status, "ready"),
    inArray(document.id, opts.documentIds),
  );
  const cols = {
    id: documentChunk.id,
    documentId: documentChunk.documentId,
    name: document.name,
    page: documentChunk.page,
    content: documentChunk.content,
    ordinal: documentChunk.ordinal,
  };

  const docs = await db.select({ id: document.id, chars: document.charCount }).from(document).where(access);
  if (docs.length === 0) return { chunks: [], embedTokens: 0, embeddingModelId: null };
  const total = docs.reduce((n, d) => n + (d.chars ?? 0), 0);
  if (total <= WHOLE_DOC_CHARS) {
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
      const r = await embed(emb.cfg, emb.key, [opts.query]);
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
  if (chunks.length === 0) {
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

/** Number sources for the model and for the UI. Whole documents are one source per document page. */
export function buildContext(chunks: RetrievedChunk[]): { system: string; citations: Citation[] } {
  if (chunks.length === 0) return { system: "", citations: [] };
  const citations: Citation[] = chunks.map((c, i) => ({
    n: i + 1,
    documentId: c.documentId,
    name: c.name,
    page: c.page,
    snippet: c.content.slice(0, 700),
  }));
  const blocks = chunks
    .map((c, i) => `[${i + 1}] ${c.name}${c.page ? `, page ${c.page}` : ""}\n${c.content}`)
    .join("\n\n---\n\n");
  const system = [
    "The user attached documents. Excerpts are below, numbered as sources.",
    "Answer using these excerpts. Cite sources inline with their number in square brackets, like [1] or [2][3], right after the claim they support.",
    "If the excerpts don't contain the answer, say so plainly instead of guessing.",
    "",
    "<sources>",
    blocks,
    "</sources>",
  ].join("\n");
  return { system, citations };
}
