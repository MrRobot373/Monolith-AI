---
name: financial-analysis
description: "Use for business finance: P&L, budget vs actual, cash flow and runway, margins, break-even, forecasts, pricing math, ratios."
category: Data
---

# Financial analysis

Finance work is judged on correctness. Every number must trace back to an input or a stated
assumption. This is analysis, not professional accounting, tax or investment advice; say so when the
stakes are high.

## Set up

1. List inputs (files, figures the person gave) and assumptions (growth rate, churn, prices) in an
   **Assumptions** table with sources. Never bury an assumption in a formula.
2. Fix units and currency; note whether figures include tax/VAT; use the period the person cares
   about (month, quarter, fiscal year).
3. Compute with pandas or plain Python using `Decimal` for money where rounding matters; build the
   deliverable in Excel (see `excel-spreadsheets`) with formulas when the person will play with it.

## Core calculations

| Metric | Formula |
|---|---|
| Gross profit / margin | Revenue − COGS; ÷ Revenue |
| Operating profit (EBIT) | Gross profit − operating expenses |
| Net margin | Net income ÷ Revenue |
| Budget variance | Actual − Budget; % = variance ÷ Budget (flag favorable/unfavorable by line type) |
| Burn rate | Average monthly net cash outflow (last 3 months) |
| Runway | Cash ÷ burn rate (months) |
| Break-even units | Fixed costs ÷ (Price − Variable cost per unit) |
| Contribution margin | Price − Variable cost (per unit), ÷ Price as % |
| CAC | Sales & marketing spend ÷ new customers (same period) |
| LTV (simple) | ARPU × gross margin % ÷ monthly churn |
| CAGR | (End ÷ Start)^(1/years) − 1 |
| DSO | Accounts receivable ÷ Revenue × days in period |
| Current ratio | Current assets ÷ current liabilities |
| Discounted price | Price × (1 − discount); yearly with discount = monthly × 12 × (1 − discount) |
| Price with tax | Net × (1 + tax rate); net from gross = gross ÷ (1 + rate) |

## Forecasts and scenarios

- Build from drivers (customers × price × retention), not by stretching totals.
- Three scenarios — conservative, base, optimistic — differing only in a few named assumptions.
- Show monthly for the first 12 months, then quarterly/yearly.
- Sensitivity: how the result changes when the most uncertain input moves ±10–20%.

## Checks

- Statements tie out: P&L net income flows to cash flow; totals equal the sum of lines.
- Reasonableness: margins within industry norms; growth rates plausible; no negative cash unless intended.
- Recalculate 2–3 key numbers by hand in your answer.
- Signs and labels: costs as positive numbers in cost lines, consistent everywhere.

## Present

- Lead with the answer: "At the current burn of $42k/month, cash lasts 14 months (until Dec 2027)."
- A compact table of the key figures; then drivers; then risks and assumptions.
- Format: thousands separators, currency symbol, negatives in parentheses or with a minus
  consistently, percentages to one decimal.

## Done when

Inputs and assumptions are explicit, calculations are checked and tie out, the main answer is
stated first with its key numbers, and limitations are noted.
