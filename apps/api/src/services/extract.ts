/**
 * Text extraction and chunking for uploaded documents. Everything runs locally.
 */

export interface PageText {
  page: number | null;
  text: string;
}

export interface Chunk {
  ordinal: number;
  page: number | null;
  content: string;
}

export class UnsupportedFileError extends Error {}

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml",
  "js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp", "cs", "kt", "swift",
  "sql", "sh", "css", "scss", "vue", "svelte",
]);

export const SUPPORTED_HINT = "PDF, Word (.docx), text, Markdown, CSV and code files";

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isSupported(name: string): boolean {
  const ext = extensionOf(name);
  return ext === "pdf" || ext === "docx" || TEXT_EXTENSIONS.has(ext);
}

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export async function extractText(name: string, data: Buffer): Promise<PageText[]> {
  const ext = extensionOf(name);
  if (ext === "pdf") {
    const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(data));
    const { text } = await pdfText(pdf, { mergePages: false });
    return (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: data });
    return [{ page: null, text: value }];
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = data.toString("utf8");
    return [{ page: null, text: ext === "html" || ext === "htm" ? stripHtml(text) : text }];
  }
  throw new UnsupportedFileError(`This file type isn't supported yet. Upload ${SUPPORTED_HINT}.`);
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Split long text on sentence boundaries, falling back to hard cuts. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  const sentences = text.match(/[^.!?\n]+[.!?]*\s*/g) ?? [text];
  let cur = "";
  for (const s of sentences) {
    if (s.length > max) {
      if (cur) out.push(cur), (cur = "");
      for (let i = 0; i < s.length; i += max) out.push(s.slice(i, i + max));
      continue;
    }
    if ((cur + s).length > max && cur) out.push(cur), (cur = "");
    cur += s;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

/**
 * Paragraph-aware chunks of ~`size` characters with ~`overlap` characters carried over,
 * so an answer that spans a boundary is still found. Each chunk keeps its starting page.
 */
export function chunkPages(pages: PageText[], size = 1200, overlap = 200): Chunk[] {
  const chunks: Chunk[] = [];
  let cur = "";
  let carried = 0; // length of `cur` that is overlap copied from the previous chunk
  let curPage: number | null = null;

  const flush = () => {
    const content = cur.trim();
    if (content) chunks.push({ ordinal: chunks.length, page: curPage, content });
    const tail = content.slice(-overlap);
    const cut = tail.indexOf(" ");
    cur = content.length > overlap && cut >= 0 ? tail.slice(cut + 1) + "\n" : "";
    carried = cur.length;
  };

  for (const p of pages) {
    const paras = normalize(p.text).split(/\n\n+/);
    for (const para of paras) {
      for (const piece of splitLong(para, size)) {
        if (cur.length === carried) curPage = p.page;
        if (cur.length + piece.length > size && cur.trim()) {
          flush();
          curPage = p.page;
        }
        cur += (cur && !cur.endsWith("\n") ? "\n\n" : "") + piece;
      }
    }
  }
  // Emit the remainder only if it has new text beyond the carried-over overlap.
  if (cur.length > carried && cur.trim()) chunks.push({ ordinal: chunks.length, page: curPage, content: cur.trim() });
  return chunks;
}
