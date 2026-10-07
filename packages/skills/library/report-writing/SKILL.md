---
name: report-writing
description: "Use when writing an analytical or research report, business case or executive summary: findings, evidence, recommendations, sources."
category: Documents & writing
---

# Report writing

## Structure

1. **Title** and one-line subtitle (scope, date, author).
2. **Executive summary** (≤ 1 page): the question, the answer, the 3–5 key findings with numbers,
   the recommendation and what it costs/needs. A busy reader stops here.
3. **Background / scope**: why this report, what's in and out, period covered.
4. **Method / sources**: data used, how it was analyzed, limitations.
5. **Findings**: one section per finding; headline sentence + evidence (numbers, charts, quotes).
6. **Recommendations**: specific, actionable, prioritized, with owner, cost/effort and expected impact.
7. **Risks and open questions.**
8. **Appendix**: detailed tables, definitions, methodology details.
9. **Sources**: numbered list with titles, publishers, dates and links.

## Writing findings

- Lead with the insight, then the evidence: "Repeat customers bring 62% of revenue but only 18% of
  marketing spend targets them (Table 2)."
- Quantify: absolute numbers and percentages, with period and comparison.
- Separate fact from interpretation ("the data shows…" vs "this suggests…").
- Each chart/table is numbered, titled with its takeaway, and referenced in the text.

## Evidence and sources

- Prefer primary sources (official statistics, company filings, original studies) over summaries.
- Record for each source: title, publisher, date, URL, and what you used it for. Cite inline as [1].
- Flag low-confidence numbers and conflicts between sources; never invent figures or citations.
- If facts come from web search, use the `web-research` skill's method.

## Recommendations template

| # | Recommendation | Why (finding) | Effort | Impact | Owner | When |
|---|---|---|---|---|---|---|
| 1 | Launch a loyalty email series | F2: repeat buyers = 62% of revenue | Low | High | Marketing | Nov |

## Style

Plain language, short paragraphs, informative headings (statements, not labels), consistent
terminology and number formats. Use the person's or organization's template when provided.

## Produce

Write in Markdown (`report.md`), with charts as PNGs (see `charts-visualization`). Convert if asked:
Word via `word-documents` (`md_to_docx.py`), PDF via `pdf-documents` (`md_to_pdf.py`).

## Review checklist

- [ ] The executive summary alone answers the question.
- [ ] Every claim has evidence or a source; numbers match the data/appendix.
- [ ] Recommendations follow from findings and are actionable.
- [ ] Limitations are stated.
- [ ] Headings read as a summary when skimmed.

## Done when

The report answers the question up front, findings are evidenced and cited, recommendations are
specific, and the document is delivered in the requested format.
