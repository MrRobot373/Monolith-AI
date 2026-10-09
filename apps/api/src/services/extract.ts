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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);
const SHEET_EXTENSIONS = new Set(["xlsx", "xlsm"]);
/** Pages with less text than this are treated as scanned and read with OCR. */
const SCANNED_PAGE_CHARS = 25;
const MAX_OCR_PAGES = 60;
const MAX_SHEET_ROWS = 20_000;

const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "htm", "log", "ini", "toml",
  "js", "jsx", "ts", "tsx", "py", "java", "go", "rs", "rb", "php", "c", "h", "cpp", "hpp", "cs", "kt", "swift",
  "sql", "sh", "css", "scss", "vue", "svelte",
]);

export const SUPPORTED_HINT = "PDF, Word (.docx), Excel (.xlsx), images, text, Markdown, CSV and code files";

export function extensionOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i >= 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function isSupported(name: string): boolean {
  const ext = extensionOf(name);
  return ext === "pdf" || ext === "docx" || TEXT_EXTENSIONS.has(ext) || SHEET_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
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

function cellText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") {
    const o = v as { result?: unknown; text?: string; richText?: { text: string }[]; hyperlink?: string; error?: string };
    if (o.richText) return o.richText.map((r) => r.text).join("");
    if (o.result !== undefined) return cellText(o.result);
    if (o.text !== undefined) return String(o.text);
    if (o.error) return o.error;
    return "";
  }
  return String(v).replace(/\s+/g, " ").trim();
}

/** Each sheet becomes one "page": a header line with the sheet name, then one line per row, cells separated by " | ". */
async function extractSheets(data: Buffer): Promise<PageText[]> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ArrayBuffer);
  const pages: PageText[] = [];
  wb.eachSheet((ws, i) => {
    const lines: string[] = [];
    let rows = 0;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (rows++ >= MAX_SHEET_ROWS) return;
      const cells = (row.values as unknown[]).slice(1).map(cellText);
      while (cells.length && !cells[cells.length - 1]) cells.pop();
      if (cells.some(Boolean)) lines.push(cells.join(" | "));
    });
    // Blank lines every 25 rows let the chunker split big sheets on row boundaries.
    const body = lines.map((l, n) => (n > 0 && n % 25 === 0 ? `\n${l}` : l)).join("\n");
    pages.push({ page: i, text: `Sheet: ${ws.name}\n\n${body}` });
  });
  return pages;
}

async function extractPdf(data: Buffer): Promise<PageText[]> {
  const { extractText: pdfText, getDocumentProxy, renderPageAsImage } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { text } = await pdfText(pdf, { mergePages: false });
  const pages = (text as string[]).map((t, i) => ({ page: i + 1, text: t }));
  const { ocrEnabled, ocrImage } = await import("./ocr");
  if (!ocrEnabled()) return pages;
  let ocrd = 0;
  for (const p of pages) {
    if (p.text.replace(/\s/g, "").length >= SCANNED_PAGE_CHARS || ocrd >= MAX_OCR_PAGES) continue;
    const png = await renderPageAsImage(pdf, p.page, { canvasImport: () => import("@napi-rs/canvas"), scale: 2 });
    p.text = await ocrImage(Buffer.from(png));
    ocrd++;
  }
  return pages;
}

export async function extractText(name: string, data: Buffer): Promise<PageText[]> {
  const ext = extensionOf(name);
  if (ext === "pdf") return extractPdf(data);
  if (SHEET_EXTENSIONS.has(ext)) return extractSheets(data);
  if (IMAGE_EXTENSIONS.has(ext)) {
    const { ocrEnabled, ocrImage } = await import("./ocr");
    if (!ocrEnabled()) throw new UnsupportedFileError("Reading text from images (OCR) is turned off on this server.");
    return [{ page: null, text: await ocrImage(data) }];
  }
  if (ext === "docx") {
    const mammoth = await import("mammoth");
    const { value } = await mammoth.extractRawText({ buffer: data });
    return [{ page: null, text: value }];
  }
  if (TEXT_EXTENSIONS.has(ext)) {
    const text = decodeText(data);
    return [{ page: null, text: ext === "html" || ext === "htm" ? stripHtml(text) : text }];
  }
  throw new UnsupportedFileError(`This file type isn't supported yet. Upload ${SUPPORTED_HINT}.`);
}

/**
 * A text file's characters. Windows saves "Unicode" text and Excel's "Unicode Text" as UTF-16,
 * which read as UTF-8 is every other byte a NUL; tell it by the byte-order mark, or without one by
 * the zero bytes in every other position.
 */
export function decodeText(data: Buffer): string {
  // UTF-16 comes in pairs of bytes; a stray last byte is dropped.
  const le = (b: Buffer) => b.subarray(0, b.length & ~1).toString("utf16le");
  const be = (b: Buffer) => Buffer.from(b.subarray(0, b.length & ~1)).swap16().toString("utf16le");
  if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) return data.subarray(3).toString("utf8");
  if (data[0] === 0xff && data[1] === 0xfe) return le(data.subarray(2));
  if (data[0] === 0xfe && data[1] === 0xff) return be(data.subarray(2));
  const pairs = Math.min(data.length, 4000) >> 1;
  if (pairs >= 2) {
    let even = 0;
    let odd = 0;
    for (let i = 0; i < pairs; i++) {
      if (data[2 * i] === 0) even++;
      if (data[2 * i + 1] === 0) odd++;
    }
    if (odd > pairs * 0.4 && even < pairs * 0.05) return le(data);
    if (even > pairs * 0.4 && odd < pairs * 0.05) return be(data);
  }
  return data.toString("utf8");
}

function normalize(text: string): string {
  return text
    // Postgres text can't hold NUL, and other control characters only get in the way of search.
    .replace(/[\u0000-\u0008\u000e-\u001f\u007f]/g, "")
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
