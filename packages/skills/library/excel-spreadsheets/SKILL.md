---
name: excel-spreadsheets
description: "Use when creating, reading or editing Excel (.xlsx): formatted sheets, formulas, totals, charts, cleaning messy sheets. Has a helper."
category: Data
---

# Excel spreadsheets

openpyxl and pandas are installed. Produce workbooks that look finished: headers styled, columns
sized, numbers formatted, totals right.

## Read

```python
import pandas as pd
sheets = pd.read_excel("input.xlsx", sheet_name=None)        # dict of all sheets
for name, df in sheets.items(): print(name, df.shape)
df = pd.read_excel("input.xlsx", sheet_name="Data", header=2)  # header on the 3rd row
```

Messy sheets: find the real header row (`df.head(15)`), drop empty rows/columns
(`dropna(how="all")`), remove subtotal rows, unmerge headers by forward-filling (`ffill`).
To read formulas' cached values with openpyxl use `load_workbook(path, data_only=True)`.

## Write formatted sheets (helper)

`scripts/xlsx_helpers.py` in this skill's folder writes DataFrames as styled tables:

```python
import sys; sys.path.insert(0, "<base dir>/scripts")   # this skill's folder
from xlsx_helpers import write_sheets
write_sheets("report.xlsx", {
    "Summary": summary_df,
    "By region": by_region_df,
}, money=["revenue", "total"], percent=["share"], dates=["date"], totals=["revenue"])
```

It bolds and colors the header row, freezes it, adds an autofilter, sizes columns, applies number
formats (thousands separators, currency, %, dates) and optionally a SUM total row with live formulas.

## openpyxl essentials

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment
from openpyxl.formatting.rule import CellIsRule
from openpyxl.chart import BarChart, Reference

wb = load_workbook("report.xlsx"); ws = wb["By region"]
ws["E2"] = "=C2*D2"                                  # formulas are strings starting with =
ws.conditional_formatting.add("C2:C100", CellIsRule(operator="lessThan", formula=["0"], font=Font(color="C00000")))
chart = BarChart(); chart.title = "Revenue by region"
chart.add_data(Reference(ws, min_col=2, min_row=1, max_row=5), titles_from_data=True)
chart.set_categories(Reference(ws, min_col=1, min_row=2, max_row=5))
ws.add_chart(chart, "E2"); wb.save("report.xlsx")
```

## Rules

- One table per sheet starting at A1, one header row, no merged cells inside data.
- Keep raw data on its own sheet; summaries reference it (formulas) or are computed values —
  state which. Formulas keep the workbook live; values are safer to share.
- Number formats: `#,##0`, `#,##0.00`, `"$"#,##0.00` (or the currency asked for), `0.0%`,
  `yyyy-mm-dd`. Never store numbers as text.
- Name sheets clearly (≤ 31 characters, no `/ \ ? * [ ]`).
- Don't overwrite the person's original file; save a new one unless asked.

## Verify

Re-open the saved file and print what's in it:
```python
wb = load_workbook("report.xlsx")
for ws in wb: print(ws.title, ws.dimensions, [c.value for c in ws[1]])
```
Check totals against pandas, and that formulas reference the right ranges.

## Done when

The workbook opens, sheets are named and formatted, numbers and totals are correct and checked, and
your summary lists the sheets and what each contains.
