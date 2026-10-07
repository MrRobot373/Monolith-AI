---
name: pdf-documents
description: "Use when working with PDFs: extract text, merge, split, rotate, watermark, or create a polished PDF from Markdown. Has a script."
category: Documents & writing
---

# PDF documents

Installed: `pypdf` (read, merge, split, rotate, watermark, metadata) and `reportlab` (create).

## Create a PDF

Write the content as Markdown, then render it:

```bash
python3 scripts/md_to_pdf.py invoice.md "INV-2026-0042.pdf" --title "Invoice INV-2026-0042" --footer "Acme Services · billing@acme.example"
```

Supports headings, paragraphs, bold/italic/code, links, lists, tables (shaded header, repeated on
new pages), notes (`>`), images (`![](chart.png)`), page breaks (`---`) and page numbers. Use
`--letter` for US Letter (default A4).

For a fixed layout (certificates, letterheads), use reportlab's canvas directly:
```python
from reportlab.lib.pagesizes import A4, landscape
from reportlab.pdfgen import canvas
c = canvas.Canvas("certificate.pdf", pagesize=landscape(A4)); w, h = landscape(A4)
c.setFont("Helvetica-Bold", 32); c.drawCentredString(w / 2, h - 200, "Certificate of Completion")
c.setFont("Helvetica", 18); c.drawCentredString(w / 2, h - 260, "Asha Rao"); c.save()
```

## Read and extract

```python
from pypdf import PdfReader
r = PdfReader("contract.pdf")
print(len(r.pages), r.metadata)
text = "\n\n".join(f"--- page {i+1} ---\n{p.extract_text() or ''}" for i, p in enumerate(r.pages))
open("contract.txt", "w", encoding="utf-8").write(text)
```

- Scanned PDFs have no text layer (`extract_text()` returns little or nothing): say so; OCR would be
  needed (`pdftoppm` + `tesseract` if installed).
- Tables come out as lines of text; rebuild them with regular expressions or by splitting on runs
  of spaces, and check totals against the document.
- Keep page numbers when quoting so people can find the source.

## Edit pages

```python
from pypdf import PdfReader, PdfWriter
w = PdfWriter()
for path in ["cover.pdf", "report.pdf", "appendix.pdf"]:          # merge
    for page in PdfReader(path).pages: w.add_page(page)
w.write("combined.pdf")

r = PdfReader("big.pdf"); part = PdfWriter()                     # split pages 1–5
for p in r.pages[0:5]: part.add_page(p)
part.write("pages-1-5.pdf")

page = r.pages[0]; page.rotate(90)                               # rotate
stamp = PdfReader("watermark.pdf").pages[0]; page.merge_page(stamp)   # watermark (make it with reportlab)
```

Encrypted PDFs: `r.decrypt(password)` only with a password the person gave you.

## Checks

Open the output with `PdfReader` and confirm the page count and that text extracts as expected;
for created PDFs, re-read the Markdown source for typos and verify numbers (totals, dates).

## Done when

The PDF exists with the right pages and content, extracted text is saved with page references, and
you reported anything that couldn't be read (scans, images).
