---
name: invoicing-bookkeeping
description: "Use for bookkeeping: invoices, categorizing bank/card transactions, reconciling payments, receivables aging, VAT/GST summaries."
category: Business
---

# Invoicing and bookkeeping

Accuracy first: every figure reconciles, nothing is invented. This supports bookkeeping; tax filings
and advice belong to an accountant.

## Invoices

Required elements: seller name/address/tax id, buyer details, invoice number (sequential, unique;
follow the organization's invoice skill if one exists), issue and due dates, line items (description,
qty, unit price, amount), subtotal, discounts, tax by rate, total, currency, payment terms and
instructions. Compute with `Decimal` and round per line or per total consistently (see
`proposals-quotes` for the code). Produce PDF via `pdf-documents` or Word via `word-documents`.

## Categorizing transactions

1. Load the bank/card export (CSV/Excel) with pandas; normalize dates, amounts (debits negative),
   and descriptions (`str.upper().str.strip()`).
2. Map to categories with explicit rules (merchant keyword → category) in a dict you show the person:
   ```python
   RULES = {"AWS": "Software & hosting", "GOOGLE*WORKSPACE": "Software & hosting",
            "UBER": "Travel", "SWIGGY": "Meals", "RENT": "Rent", "PAYROLL": "Salaries"}
   ```
3. Unmatched rows go to "Uncategorized — review" (never guess silently).
4. Output: categorized file + summary by category and month (pivot), and the review list.

## Reconciliation (payments ↔ invoices)

- Match on exact amount + reference/invoice number in the description; then amount + customer name;
  then amount within a date window. Record the match rule used for each pair.
- Report: matched, partially paid, overpaid, unmatched payments, unpaid invoices.
- Totals: opening balance + receipts − payments = closing balance (must equal the bank statement).

## Receivables aging

From open invoices: buckets Current, 1–30, 31–60, 61–90, 90+ days overdue (as of a stated date),
totals per customer and bucket, and a follow-up list (see `business-writing` for reminder emails).

```python
asof = pd.Timestamp("2026-10-07")
df["days_overdue"] = (asof - df["due_date"]).dt.days.clip(lower=0)
df["bucket"] = pd.cut(df["days_overdue"], [-1, 0, 30, 60, 90, 10**6], labels=["Current", "1-30", "31-60", "61-90", "90+"])
```

## VAT/GST summary

Output tax collected (sales) and input tax paid (purchases) by rate and period, net payable. Use the
rates and rules the person gives or that appear on the documents; flag mixed or missing tax data.

## Month-end checklist

Bank reconciled · all sales invoiced · receivables reviewed and chased · bills entered and scheduled ·
expenses categorized with receipts · payroll recorded · tax summary prepared · reports (P&L, cash) shared.

## Done when

Numbers reconcile to source totals, every transaction is categorized or listed for review, outputs
are saved as files, and items needing an accountant are flagged.
