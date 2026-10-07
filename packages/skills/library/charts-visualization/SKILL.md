---
name: charts-visualization
description: "Use when making charts (bar, line, pie, scatter) with matplotlib: choosing the chart, clean styling, labels, saving PNG/SVG. Has a helper."
category: Data
---

# Charts and visualization

A chart should answer one question at a glance. The title states the answer.

## Choose the chart

| Question | Chart |
|---|---|
| Compare categories | Horizontal bar, sorted (vertical if few short labels) |
| Change over time | Line (bars for few periods or discrete counts) |
| Parts of a whole | Stacked bar or 100% bar; pie only for ≤ 4 parts |
| Relationship of two measures | Scatter (add a trend line if meaningful) |
| Distribution | Histogram or box plot |
| Target vs actual | Bar with a target line, or bullet chart |
| Two measures, different units | Two charts side by side (avoid dual axes) |

## Style (helper)

`scripts/chart_style.py` in this skill's folder applies a clean, consistent look:

```python
import sys; sys.path.insert(0, "<base dir>/scripts")
from chart_style import apply_style, PALETTE, finish
import matplotlib.pyplot as plt

apply_style()
fig, ax = plt.subplots(figsize=(8, 4.5))
d = by_region.sort_values("revenue")
ax.barh(d["region"], d["revenue"], color=PALETTE[0])
ax.bar_label(ax.containers[0], labels=[f"${v:,.0f}" for v in d["revenue"]], padding=4)
finish(fig, ax, title="North leads with 41% of revenue", subtitle="Revenue by region, Jan–Jun 2026",
       source="Source: sales.csv", path="revenue_by_region.png")
```

`finish` removes chart junk, formats the title/subtitle/source, and saves at 200 dpi with a tight
layout (also `.svg` if you give an `.svg` path).

## Rules

- Title = the takeaway ("Sales doubled after the March campaign"), subtitle = what is measured,
  units and period.
- Label axes with units; format ticks (`$12k`, `45%`, `Mar 2026`). Start bar axes at zero.
- Sort bars by value unless the categories have a natural order (months, sizes).
- Highlight what matters: one accent color for the focus, grey for the rest.
- Direct labels on bars or line ends instead of legends when possible.
- ≤ 6 colors; consistent colors for the same category across charts; colorblind-safe palette
  (the helper's `PALETTE`).
- No 3D, no shadows, no gradient fills.
- Readable at the size it'll be used: 8×4.5 in for slides/reports, font ≥ 10 pt.

## Matplotlib snippets

```python
import matplotlib.ticker as mt
ax.yaxis.set_major_formatter(mt.FuncFormatter(lambda v, _: f"${v/1000:,.0f}k"))
ax.xaxis.set_major_formatter(mt.PercentFormatter(1.0))
ax.axhline(target, color="#6B7280", linestyle="--", linewidth=1); ax.text(x0, target, " Target", va="bottom")
for x, y in zip(df["month"], df["sales"]): pass  # annotate selected points with ax.annotate(...)
import matplotlib.dates as md; ax.xaxis.set_major_formatter(md.DateFormatter("%b %Y"))
```

Use the Agg backend for files (the helper sets it). Close figures in loops (`plt.close(fig)`).

## Check

Open the saved image with `read_image` if the model can see images, or at least confirm the file
exists and its size is reasonable (`ls -l`). Verify the numbers in labels match the data.

## Done when

Each chart answers one question, has a takeaway title, labeled axes with units, correct numbers,
and is saved as a file named after its content.
