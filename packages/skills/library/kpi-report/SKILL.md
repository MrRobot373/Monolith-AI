---
name: kpi-report
description: "Use when producing a recurring KPI report or dashboard: period comparisons, targets, highlights, as Markdown, Excel or HTML."
category: Data
---

# KPI report and dashboard

A KPI report tells the reader in 30 seconds whether things are on track and what needs attention.

## 1. Define the KPIs (once)

For each KPI write: name, exact formula, data source, period, owner, target, and whether up is good.
Keep it to 5–8 headline KPIs; details go in an appendix.

| KPI | Formula | Target | Good when |
|---|---|---|---|
| Revenue | sum(paid invoices) in period | $120k/mo | ↑ |
| New customers | count(first purchase in period) | 40/mo | ↑ |
| Churn | customers lost ÷ customers at start | < 3% | ↓ |
| Avg response time | median first reply (hours) | < 4 h | ↓ |

## 2. Compute

- Current period vs previous period and vs same period last year; vs target.
- Use complete periods (or compare month-to-date with the same days last month).
- Keep the computation in a script (`kpis.py`) so next period is one command.

```python
def change(cur, prev):
    return None if not prev else (cur - prev) / prev
status = "on track" if (cur >= target if higher_is_better else cur <= target) else "off track"
```

## 3. Structure of the report

1. **Headline** (one sentence): "Revenue hit $131k (+9% MoM, 109% of target); churn rose to 3.4%."
2. **Scorecard table**: KPI · This period · Last period · Change · Target · Status (✅/⚠️/❌ plus the word).
3. **Highlights and lowlights**: 2–3 each, with the number and the reason if known.
4. **Charts**: trend lines for the 2–3 KPIs that matter most this period (see `charts-visualization`).
5. **Actions / asks**: what needs a decision, who owns it.
6. **Appendix**: definitions and data notes.

## 4. Formats

- **Markdown** (`report.md`) for chat and email.
- **Excel** for people who want to filter: Scorecard sheet + data sheets (see `excel-spreadsheets`).
- **HTML dashboard**: one self-contained file. Embed charts as base64 PNGs so it works offline:

```python
import base64
img = base64.b64encode(open("revenue.png", "rb").read()).decode()
html = f"""<!doctype html><html><head><meta charset="utf-8"><title>KPIs — {period}</title>
<style>body{{font-family:system-ui;margin:2rem;color:#111}} table{{border-collapse:collapse}}
td,th{{padding:.4rem .8rem;border-bottom:1px solid #e5e7eb;text-align:right}} td:first-child,th:first-child{{text-align:left}}
.off{{color:#b91c1c}} .on{{color:#047857}}</style></head><body>
<h1>{headline}</h1>{scorecard_html}<img alt="Revenue trend" src="data:image/png;base64,{img}" width="720"></body></html>"""
open("dashboard.html", "w", encoding="utf-8").write(html)
```

## Checks

KPI values recomputed from raw data match the scorecard; periods are complete and labeled;
percent changes use the right base; colors/status agree with "good when" direction.

## Done when

The headline answers "are we on track?", every KPI has its definition, comparisons and target,
charts support the story, and the script can regenerate the report next period.
