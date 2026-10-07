---
name: data-analysis
description: "Use when analyzing CSV/Excel/JSON data with pandas: exploring, grouping, trends, comparisons, checked numbers and saved results."
category: Data
---

# Data analysis

Answer the question with numbers you have checked, and show your work in files people can open.

## 1. Frame the question

Restate it precisely: the metric, the grouping, the period, filters ("Revenue = units × unit price,
per region, Jan–Jun 2026, excluding refunds"). If definitions are ambiguous, pick the most sensible
one, state it, and proceed.

## 2. Load and inspect (always)

```python
import pandas as pd
df = pd.read_csv("sales.csv")                      # or pd.read_excel("file.xlsx", sheet_name=None) for all sheets
print(df.shape); print(df.dtypes); print(df.head(10).to_string())
print(df.isna().sum()); print(df.describe(include="all").T.head(30).to_string())
```

For a quick profile of any CSV/Excel run `python3 scripts/profile_data.py <file>` from the
`data-cleaning` skill. Check: units and currency, date formats, duplicate rows, negative or zero
values, category spellings (`df["region"].value_counts()`), totals rows mixed into data.

## 3. Prepare

- Parse types: `pd.to_datetime(df["date"], errors="coerce")`, `pd.to_numeric(..., errors="coerce")`;
  count what failed to parse and say so.
- Trim and normalize categories (`.str.strip().str.title()`).
- Remove exact duplicates only if they're clearly errors; report how many.
- Compute derived columns explicitly: `df["revenue"] = df["units"] * df["unit_price"]`.

## 4. Analyze

```python
by_region = (df.groupby("region", as_index=False)["revenue"].sum()
               .sort_values("revenue", ascending=False))
monthly = df.set_index("date").resample("MS")["revenue"].sum()
share = by_region.assign(share=lambda d: d["revenue"] / d["revenue"].sum())
pivot = df.pivot_table(index="region", columns=df["date"].dt.to_period("M"), values="revenue", aggfunc="sum", fill_value=0)
```

Useful patterns: period-over-period change (`pct_change()`), top-N with "Other", cohorts, moving
averages (`rolling(3).mean()`), outliers (values beyond 1.5×IQR or > 3 standard deviations).

## 5. Check the numbers

- Totals reconcile: the sum of groups equals the overall total (`assert abs(a - b) < 0.01`).
- Spot-check one group by hand from raw rows.
- Row counts before and after each filter/merge are as expected (merges can duplicate rows:
  use `validate="many_to_one"`).
- Sanity: no negative revenue unless refunds exist; percentages add to 100%.

## 6. Deliver

- Save results: `by_region.to_csv("region_revenue.csv", index=False)`; for formatted Excel output
  use the `excel-spreadsheets` skill; charts with `charts-visualization` (save PNG).
- Write `report.md`: the question, the answer in the first sentence, a small table of key numbers,
  1–3 insights with numbers ("North is 41% of revenue, up 12% vs Q1"), caveats (missing data,
  assumptions), and the list of output files.
- Round for reading (thousands separators, 1 decimal for %), but keep full precision in files.

## Pitfalls

- Averaging averages (weight by counts instead).
- Mixing currencies or units.
- Comparing partial periods to full ones (this month so far vs last month).
- Correlation stated as causation.

## Done when

The question is answered in one sentence with checked numbers, outputs are saved as files, and
assumptions and data issues are listed.
