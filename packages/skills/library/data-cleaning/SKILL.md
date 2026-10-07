---
name: data-cleaning
description: "Use when data is messy: duplicates, missing values, inconsistent spellings, mixed date/number formats, merging lists. Has a profiler."
category: Data
---

# Data cleaning

Clean data reproducibly with a script, keep the original untouched, and report every change.

## 1. Profile first

```bash
python3 scripts/profile_data.py customers.xlsx        # this skill's folder; CSV or Excel
```

It prints, per column: type guess, missing count, unique count, top values, min/max, and warnings
(mixed types, leading/trailing spaces, possible dates stored as text, numbers with currency symbols,
duplicate rows). Read it before deciding anything.

## 2. Decide the rules (write them down)

For each problem, choose a rule and note it in `cleaning_log.md`:

| Problem | Typical rule |
|---|---|
| Extra spaces, case | `str.strip()`, collapse inner spaces, consistent case for names/codes |
| Category spellings ("N.Y.", "New York", "NY") | Explicit mapping dict; print values that didn't map |
| Dates in mixed formats | `pd.to_datetime(..., format=…)` per known format; `dayfirst=True` only if the source is day-first; flag the rest |
| Numbers as text ("$1,234.50", "1.234,50") | Remove currency/thousands separators per locale, `pd.to_numeric(errors="coerce")` |
| Missing values | Leave missing unless a rule is justified (default value, carry forward within group); never invent data |
| Duplicates | Exact duplicates: drop. Fuzzy (same email, similar names): mark candidates for review, merge only on a strong key |
| Outliers | Flag, don't delete, unless clearly an error (negative age, date in 2099) |
| Phone/email | Lowercase emails; validate with a simple regex; normalize phones to E.164 when the country is known |

## 3. Apply with pandas

```python
import pandas as pd
raw = pd.read_excel("customers.xlsx")
df = raw.copy()
df["email"] = df["email"].str.strip().str.lower()
df["country"] = df["country"].str.strip().replace({"USA": "United States", "U.S.": "United States", "UK": "United Kingdom"})
df["signup"] = pd.to_datetime(df["signup"], errors="coerce", dayfirst=False)
bad_dates = df["signup"].isna() & raw["signup"].notna()
dupes = df.duplicated(subset=["email"], keep="first")
clean, removed = df[~dupes], df[dupes]
```

Keep a `issues` table of rows you couldn't fix (row number, column, value, reason) and save it.

## 4. Validate the result

- Row counts: before, removed (by reason), after — they must add up.
- Required columns have no missing values; keys are unique (`assert clean["email"].is_unique`).
- Value ranges and allowed categories hold (`assert clean["country"].isin(ALLOWED).all()`).
- Re-run the profiler on the cleaned file.

## 5. Deliver

- `*_clean.csv`/`.xlsx` (never overwrite the original), `*_issues.csv` with rows needing a human, and
  `cleaning_log.md` with rules applied and counts. Keep the script (`clean.py`) so it can be re-run
  on next month's file.

## Done when

The cleaned file passes the validation checks, every change is counted in the log, unfixable rows
are listed for review, and the original file is unchanged.
