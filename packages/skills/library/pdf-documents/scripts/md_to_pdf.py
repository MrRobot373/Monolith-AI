#!/usr/bin/env python3
"""Render simple Markdown to a clean A4/Letter PDF with reportlab.

Supports # headings (1–3), paragraphs, **bold**, *italic*, `code`, bullet/numbered lists,
tables (| a | b |), > notes, --- page breaks, ![](image.png), and a footer with page numbers.

Usage: python3 md_to_pdf.py input.md output.pdf [--title "Title"] [--letter] [--footer "Acme · Confidential"]
"""
import argparse
import html
import os
import re

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Image, ListFlowable, ListItem, PageBreak, Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table, TableStyle

ACCENT = colors.HexColor("#0F3D6E")


def inline(text):
    t = html.escape(text, quote=False)
    t = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"(?<!\*)\*([^*]+)\*(?!\*)", r"<i>\1</i>", t)
    t = re.sub(r"`([^`]+)`", r'<font face="Courier">\1</font>', t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<link href="\2" color="#1F4E99">\1</link>', t)
    return t


def styles():
    ss = getSampleStyleSheet()
    base = ParagraphStyle("Body", parent=ss["BodyText"], fontName="Helvetica", fontSize=10.5, leading=15, spaceAfter=6, alignment=TA_LEFT)
    return {
        "body": base,
        "h1": ParagraphStyle("H1", parent=base, fontName="Helvetica-Bold", fontSize=20, leading=25, textColor=ACCENT, spaceBefore=6, spaceAfter=10),
        "h2": ParagraphStyle("H2", parent=base, fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=ACCENT, spaceBefore=12, spaceAfter=6),
        "h3": ParagraphStyle("H3", parent=base, fontName="Helvetica-Bold", fontSize=11.5, leading=15, spaceBefore=8, spaceAfter=4),
        "note": ParagraphStyle("Note", parent=base, leftIndent=10, borderPadding=6, backColor=colors.HexColor("#F3F4F6"), textColor=colors.HexColor("#374151")),
        "cell": ParagraphStyle("Cell", parent=base, fontSize=9.5, leading=12, spaceAfter=0),
        "code": ParagraphStyle("Code", parent=base, fontName="Courier", fontSize=9, leading=11.5, backColor=colors.HexColor("#F3F4F6")),
    }


def build(md, out, title=None, pagesize=A4, footer=None, base_dir="."):
    st = styles()
    flow, lines, i = [], md.splitlines(), 0
    width = pagesize[0] - 40 * mm
    while i < len(lines):
        line, s = lines[i], lines[i].strip()
        if not s:
            i += 1
            continue
        if s.startswith("```"):
            code = []
            i += 1
            while i < len(lines) and not lines[i].strip().startswith("```"):
                code.append(lines[i])
                i += 1
            flow.append(Preformatted("\n".join(code), st["code"]))
            i += 1
            continue
        if s == "---":
            flow.append(PageBreak())
        elif m := re.match(r"^(#{1,3})\s+(.*)", s):
            flow.append(Paragraph(inline(m.group(2)), st[f"h{len(m.group(1))}"]))
        elif m := re.match(r"!\[[^\]]*\]\(([^)]+)\)", s):
            path = m.group(1) if os.path.isabs(m.group(1)) else os.path.join(base_dir, m.group(1))
            img = Image(path)
            scale = min(width / img.imageWidth, (110 * mm) / img.imageHeight, 1.0)
            img.drawWidth, img.drawHeight = img.imageWidth * scale, img.imageHeight * scale
            flow += [img, Spacer(1, 6)]
        elif s.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].strip().startswith("|"):
                r = lines[i].strip()
                if not re.fullmatch(r"\|?[\s:|-]+\|?", r):
                    rows.append([Paragraph(inline(c.strip()), st["cell"]) for c in r.strip("|").split("|")])
                i += 1
            n = max(len(r) for r in rows)
            rows = [r + [""] * (n - len(r)) for r in rows]
            t = Table(rows, colWidths=[width / n] * n, repeatRows=1)
            t.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#E7EBF0")),
                ("LINEBELOW", (0, 0), (-1, 0), 0.8, ACCENT),
                ("LINEBELOW", (0, 1), (-1, -1), 0.3, colors.HexColor("#D1D5DB")),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ]))
            flow += [t, Spacer(1, 8)]
            continue
        elif re.match(r"^\s*([-*+]|\d+[.)])\s+", line):
            items, numbered = [], bool(re.match(r"^\s*\d", line))
            while i < len(lines) and (m := re.match(r"^(\s*)([-*+]|\d+[.)])\s+(.*)", lines[i])) and (len(m.group(1)) >= 2 or m.group(2)[0].isdigit() == numbered):
                items.append(ListItem(Paragraph(inline(m.group(3)), st["body"]), leftIndent=12 + (12 if len(m.group(1)) >= 2 else 0)))
                i += 1
            flow.append(ListFlowable(items, bulletType="1" if numbered else "bullet", start=None if numbered else "•", leftIndent=14))
            continue
        elif s.startswith(">"):
            flow.append(Paragraph(inline(s.lstrip("> ")), st["note"]))
        else:
            para = [s]
            while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(r"^(\s*([-*+]|\d+[.)])\s|#|\||>|```|---|!\[)", lines[i + 1].strip()):
                i += 1
                para.append(lines[i].strip())
            flow.append(Paragraph(inline(" ".join(para)), st["body"]))
        i += 1

    def on_page(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8.5)
        canvas.setFillColor(colors.HexColor("#6B7280"))
        if footer:
            canvas.drawString(20 * mm, 12 * mm, footer)
        canvas.drawRightString(pagesize[0] - 20 * mm, 12 * mm, f"Page {doc.page}")
        canvas.restoreState()

    doc = SimpleDocTemplate(out, pagesize=pagesize, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=20 * mm, title=title or "", author="")
    doc.build(flow, onFirstPage=on_page, onLaterPages=on_page)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--title")
    ap.add_argument("--letter", action="store_true", help="US Letter instead of A4")
    ap.add_argument("--footer")
    a = ap.parse_args()
    build(open(a.input, encoding="utf-8").read(), a.output, a.title, letter if a.letter else A4, a.footer, os.path.dirname(os.path.abspath(a.input)))
    print(f"Wrote {a.output}")
