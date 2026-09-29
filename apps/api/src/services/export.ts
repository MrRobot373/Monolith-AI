/**
 * Export chats and answers to Word (.docx) and Markdown. Runs locally, no external services.
 * PDF export happens in the browser (print view), which keeps fonts, code and tables faithful.
 */
import type { Citation } from "@aatmiq/db";
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import { marked, type Token, type Tokens } from "marked";

export interface ExportMessage {
  role: "user" | "assistant";
  author: string;
  content: string;
  citations?: Citation[] | null;
}

const LABEL = { confirmed: "Confirmed", assumption: "Assumption", tbd: "TBD" } as const;
const MONO = "Consolas";
const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

type Style = { bold?: boolean; italics?: boolean; strike?: boolean; code?: boolean };

function decode(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function inline(tokens: Token[] | undefined, style: Style = {}): ParagraphChild[] {
  const out: ParagraphChild[] = [];
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "strong":
        out.push(...inline((t as Tokens.Strong).tokens, { ...style, bold: true }));
        break;
      case "em":
        out.push(...inline((t as Tokens.Em).tokens, { ...style, italics: true }));
        break;
      case "del":
        out.push(...inline((t as Tokens.Del).tokens, { ...style, strike: true }));
        break;
      case "codespan":
        out.push(new TextRun({ text: decode((t as Tokens.Codespan).text), font: MONO, shading: { type: ShadingType.CLEAR, fill: "EEEEEE", color: "auto" } }));
        break;
      case "br":
        out.push(new TextRun({ text: "", break: 1 }));
        break;
      case "link": {
        const l = t as Tokens.Link;
        // In-app citation anchors ("#cite-1") are plain text in a document.
        if (!/^https?:|^mailto:/.test(l.href)) {
          out.push(...inline(l.tokens, style));
          break;
        }
        out.push(new ExternalHyperlink({ link: l.href, children: [new TextRun({ text: decode(l.text), style: "Hyperlink", ...style })] }));
        break;
      }
      case "text": {
        const tx = t as Tokens.Text;
        if (tx.tokens?.length) out.push(...inline(tx.tokens, style));
        else out.push(new TextRun({ text: decode(tx.text), bold: style.bold, italics: style.italics, strike: style.strike }));
        break;
      }
      case "escape":
        out.push(new TextRun({ text: decode((t as Tokens.Escape).text), ...style }));
        break;
      default:
        if ("text" in t && typeof t.text === "string") out.push(new TextRun({ text: decode(t.text), ...style }));
    }
  }
  return out;
}

function blocks(tokens: Token[], depth = 0, quote = false): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const para = (children: ParagraphChild[], extra: Partial<ConstructorParameters<typeof Paragraph>[0] & object> = {}) =>
    new Paragraph({
      children,
      spacing: { after: 120 },
      ...(quote ? { indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 12, color: "BBBBBB", space: 8 } } } : {}),
      ...extra,
    });
  for (const t of tokens) {
    switch (t.type) {
      case "heading": {
        const h = t as Tokens.Heading;
        out.push(new Paragraph({ heading: HEADINGS[Math.min(h.depth, 6) - 1], children: inline(h.tokens), spacing: { before: 200, after: 100 } }));
        break;
      }
      case "paragraph":
        out.push(para(inline((t as Tokens.Paragraph).tokens)));
        break;
      case "text":
        out.push(para(inline((t as Tokens.Text).tokens ?? [t])));
        break;
      case "code": {
        const lines = (t as Tokens.Code).text.split("\n");
        out.push(
          new Paragraph({
            shading: { type: ShadingType.CLEAR, fill: "F4F4F4", color: "auto" },
            spacing: { after: 160 },
            children: lines.map((line, i) => new TextRun({ text: line, font: MONO, size: 18, break: i > 0 ? 1 : 0 })),
          }),
        );
        break;
      }
      case "blockquote":
        out.push(...blocks((t as Tokens.Blockquote).tokens, depth, true));
        break;
      case "list": {
        const l = t as Tokens.List;
        for (const item of l.items) {
          const [first, ...rest] = item.tokens;
          const firstChildren = first && (first.type === "text" || first.type === "paragraph") ? inline((first as Tokens.Text).tokens ?? [first]) : [];
          out.push(
            new Paragraph({
              children: [...(item.task ? [new TextRun(item.checked ? "☑ " : "☐ ")] : []), ...firstChildren],
              ...(l.ordered ? { numbering: { reference: "numbers", level: Math.min(depth, 5) } } : { bullet: { level: Math.min(depth, 5) } }),
              spacing: { after: 60 },
            }),
          );
          const restTokens = firstChildren.length ? rest : item.tokens;
          for (const sub of restTokens) {
            if (sub.type === "list") out.push(...blocks([sub], depth + 1, quote));
            else out.push(...blocks([sub], depth, quote));
          }
        }
        break;
      }
      case "table": {
        const tb = t as Tokens.Table;
        const cell = (c: Tokens.TableCell, header: boolean) =>
          new TableCell({
            children: [new Paragraph({ children: inline(c.tokens, header ? { bold: true } : {}) })],
            shading: header ? { type: ShadingType.CLEAR, fill: "EFEFEF", color: "auto" } : undefined,
          });
        out.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: [new TableRow({ tableHeader: true, children: tb.header.map((c) => cell(c, true)) }), ...tb.rows.map((r) => new TableRow({ children: r.map((c) => cell(c, false)) }))],
          }),
          new Paragraph({ children: [], spacing: { after: 120 } }),
        );
        break;
      }
      case "hr":
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: "CCCCCC", space: 1 } }, spacing: { after: 120 } }));
        break;
      case "space":
        break;
      default:
        if ("text" in t && typeof t.text === "string") out.push(para([new TextRun(decode(t.text))]));
    }
  }
  return out;
}

export function markdownToDocxBlocks(md: string) {
  return blocks(marked.lexer(md));
}

function sourcesBlock(citations: Citation[]): Paragraph[] {
  return [
    new Paragraph({ children: [new TextRun({ text: "Sources", bold: true, size: 18, color: "666666" })], spacing: { before: 120, after: 40 } }),
    ...citations.map(
      (c) =>
        new Paragraph({
          spacing: { after: 20 },
          children: [
            new TextRun({
              text: `[${c.n}] ${c.kind === "chat" ? `Earlier chat: ${c.name}` : c.name}${c.page ? `, page ${c.page}` : ""}${c.label ? ` (${LABEL[c.label]})` : ""}`,
              size: 18,
              color: "666666",
            }),
          ],
        }),
    ),
  ];
}

export async function chatToDocx(opts: { title: string; subtitle: string; messages: ExportMessage[] }): Promise<Buffer> {
  const children: (Paragraph | Table)[] = [
    new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(opts.title)] }),
    new Paragraph({ children: [new TextRun({ text: opts.subtitle, color: "777777", size: 18 })], spacing: { after: 240 } }),
  ];
  const single = opts.messages.length === 1;
  for (const m of opts.messages) {
    if (!single) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: m.author, bold: true, color: m.role === "user" ? "444444" : "0E7490" })],
          spacing: { before: 240, after: 80 },
          border: { top: { style: BorderStyle.SINGLE, size: 4, color: "E5E5E5", space: 6 } },
        }),
      );
    }
    children.push(...markdownToDocxBlocks(m.content));
    if (m.citations?.length) children.push(...sourcesBlock(m.citations));
  }
  const doc = new Document({
    creator: "Aatmiq",
    title: opts.title,
    styles: { default: { document: { run: { font: "Calibri", size: 22 } } } },
    numbering: {
      config: [
        {
          reference: "numbers",
          levels: [0, 1, 2, 3, 4, 5].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

export function chatToMarkdown(opts: { title: string; subtitle: string; messages: ExportMessage[] }): string {
  const parts = [`# ${opts.title}`, `_${opts.subtitle}_`];
  const single = opts.messages.length === 1;
  for (const m of opts.messages) {
    if (!single) parts.push(`---\n\n**${m.author}**`);
    parts.push(m.content);
    if (m.citations?.length)
      parts.push(
        "Sources:\n" +
          m.citations
            .map((c) => `- [${c.n}] ${c.kind === "chat" ? `Earlier chat: ${c.name}` : c.name}${c.page ? `, page ${c.page}` : ""}${c.label ? ` (${LABEL[c.label]})` : ""}`)
            .join("\n"),
      );
  }
  return parts.join("\n\n") + "\n";
}

/** A filename-safe version of a title. */
export function fileNameFor(title: string, ext: string) {
  const base = title.replace(/[^\p{L}\p{N} _.-]+/gu, "").trim().replace(/\s+/g, " ").slice(0, 80) || "Chat";
  return `${base}.${ext}`;
}
