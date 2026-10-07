---
name: word-documents
description: "Use when creating or editing Word documents (.docx): letters, reports, proposals, policies, or reading .docx files. Has a Markdown converter."
category: Documents & writing
---

# Word documents (.docx)

python-docx is installed. The fastest reliable path: write the content in Markdown, then convert.

## Create

1. Write the document as Markdown (`draft.md`): headings, paragraphs, lists, tables. Get the
   content right first (structure and wording); see `business-writing` / `report-writing`.
2. Convert with this skill's script:
   ```bash
   python3 scripts/md_to_docx.py draft.md "Proposal - Acme.docx" --title "Proposal for Acme" --font Calibri --size 11
   ```
   It handles headings 1–3, bold/italic/code, bullet and numbered lists (one nested level), tables
   with a shaded header row, quotes, code blocks and `---` page breaks.
3. For extra polish, open the result with python-docx and adjust (below).

## python-docx essentials

```python
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.text import WD_ALIGN_PARAGRAPH

doc = Document("Proposal - Acme.docx")
sec = doc.sections[0]
sec.left_margin = sec.right_margin = Cm(2.2)
header = sec.header.paragraphs[0]; header.text = "Acme Services · Confidential"
footer = sec.footer.paragraphs[0]; footer.text = "Proposal v1.0"; footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
p = doc.add_paragraph(); run = p.add_run("Total: $14,160"); run.bold = True; run.font.size = Pt(12)
doc.add_picture("chart.png", width=Cm(15))
doc.save("Proposal - Acme.docx")
```

Use built-in styles (`Heading 1`, `List Bullet`, `Table Grid`) instead of manual formatting so the
document stays consistent and the navigation pane works.

## Edit an existing document

- Read it: `"\n".join(p.text for p in Document(path).paragraphs)`; tables via `doc.tables`.
- Replace text inside runs carefully: text can be split across runs; replace at paragraph level when
  formatting allows, or edit the specific run.
- Save under a new name (`… - edited.docx`) unless asked to overwrite; list what changed.

## Document conventions

- Title, date, author/company; a short summary up front for anything over two pages.
- Headings that a skimmer can follow; numbered sections for contracts and policies.
- Tables for comparisons, prices, schedules; right-align numbers.
- Consistent dates (e.g. 7 October 2026) and currency formatting.
- Page numbers in the footer for long documents (add a PAGE field via python-docx XML if needed).

## Verify

Re-open the saved file and print headings and table counts:
```python
d = Document("out.docx"); print([p.text for p in d.paragraphs if p.style.name.startswith("Heading")], len(d.tables))
```
Proofread the Markdown source once more for typos, names and numbers.

## Done when

The .docx opens, structure and styles are consistent, numbers and names are checked, and you told
the person the file name and what's in it.
