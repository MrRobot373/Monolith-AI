#!/usr/bin/env python3
"""Quick profile of a CSV or Excel file: per-column types, missing values, uniques, top values,
ranges and warnings. Usage: python3 profile_data.py data.csv|data.xlsx [--sheet NAME]"""
import re
import sys

import pandas as pd

MONEY = re.compile(r"^\s*[-+]?[$€£₹¥]?\s*[\d.,]+\s*[$€£₹¥]?\s*$")
DATE = re.compile(r"^\s*(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4})(\s|T|$)")


def load(path, sheet=None):
    if path.lower().endswith((".xlsx", ".xlsm", ".xls")):
        return pd.read_excel(path, sheet_name=sheet or 0, dtype=object)
    for enc in ("utf-8-sig", "latin-1"):
        try:
            return pd.read_csv(path, dtype=object, encoding=enc, sep=None, engine="python")
        except UnicodeDecodeError:
            continue
    raise SystemExit("Couldn't decode the file")


def profile(df: pd.DataFrame):
    print(f"Rows: {len(df):,}   Columns: {len(df.columns)}")
    dup = int(df.duplicated().sum())
    if dup:
        print(f"WARNING: {dup:,} fully duplicated rows")
    empty_rows = int(df.isna().all(axis=1).sum())
    if empty_rows:
        print(f"WARNING: {empty_rows:,} completely empty rows")
    print()
    for col in df.columns:
        s = df[col]
        nonnull = s.dropna()
        text = nonnull.astype(str)
        warnings = []
        nums = pd.to_numeric(text.str.replace(r"[,$€£₹¥\s]", "", regex=True), errors="coerce")
        num_share = nums.notna().mean() if len(text) else 0
        date_share = text.str.match(DATE).mean() if len(text) else 0
        kind = "empty"
        if len(text):
            kind = "number" if num_share > 0.9 else "date-like text" if date_share > 0.8 else "text"
        if len(text) and (text != text.str.strip()).any():
            warnings.append(f"{int((text != text.str.strip()).sum())} values with leading/trailing spaces")
        if kind == "number" and text.str.contains(r"[$€£₹¥,]").any():
            warnings.append("numbers stored with currency symbols or separators")
        if 0.5 < num_share < 0.9:
            warnings.append(f"mixed: {num_share:.0%} numeric, rest text")
        if kind == "date-like text":
            formats = text.str.extract(r"^(\d{4}|\d{1,2})[-/.]")[0].str.len().value_counts().to_dict()
            if len(formats) > 1:
                warnings.append("dates in more than one format")
        lower_unique = text.str.strip().str.lower().nunique()
        if text.nunique() > lower_unique:
            warnings.append(f"{text.nunique() - lower_unique} values differ only by case/spaces")
        print(f"■ {col}  [{kind}]  missing {s.isna().sum():,} ({s.isna().mean():.0%})  unique {nonnull.nunique():,}")
        if kind == "number" and nums.notna().any():
            print(f"    min {nums.min():,.2f}  max {nums.max():,.2f}  mean {nums.mean():,.2f}")
        top = text.value_counts().head(5)
        if len(top):
            print("    top: " + " | ".join(f"{str(k)[:30]!r}×{v}" for k, v in top.items()))
        for w in warnings:
            print(f"    WARNING: {w}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    sheet = sys.argv[sys.argv.index("--sheet") + 1] if "--sheet" in sys.argv else None
    profile(load(sys.argv[1], sheet))
