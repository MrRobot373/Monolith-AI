---
name: proposals-quotes
description: "Use when writing a proposal, quotation, estimate or statement of work: scope, pricing table with checked math, timeline, terms."
category: Business
---

# Proposals, quotes and statements of work

A proposal wins when the client sees their problem understood, a clear plan, and a price they can
trust. Every number must add up.

## Inputs to collect (or state as assumptions)

Client name and contact, their goal and pain in their words, scope requested, deadline, budget hints,
your rates/prices, tax rules (VAT/GST %), currency, payment terms, validity period, and the decision
date. If the RFP/brief is a file, read it fully and list every requirement.

## Proposal structure

1. **Cover**: title, client, your company, date, reference number.
2. **Executive summary**: their goal, your solution in 3 sentences, total investment, timeline.
3. **Understanding of the need**: their situation and success criteria (shows you listened).
4. **Approach / solution**: phases with activities and deliverables.
5. **Scope**: in scope / out of scope (explicit), client responsibilities.
6. **Timeline**: milestones with dates or weeks from start (table or Mermaid Gantt).
7. **Pricing**: table (below); options or tiers if useful (good/better/best).
8. **Team and relevant experience**: short, specific.
9. **Assumptions, terms and next steps**: validity, payment schedule, how to accept.

## Pricing table and math

| # | Item | Qty | Unit | Unit price | Amount |
|---|---|---|---|---|---|
| 1 | Discovery workshop | 1 | day | 1,200.00 | 1,200.00 |
| 2 | Implementation | 40 | hours | 95.00 | 3,800.00 |
| | **Subtotal** | | | | **5,000.00** |
| | Discount 10% | | | | −500.00 |
| | **Net** | | | | **4,500.00** |
| | VAT 18% | | | | 810.00 |
| | **Total** | | | | **5,310.00** |

Compute with code, not by eye:
```python
from decimal import Decimal as D, ROUND_HALF_UP
lines = [(D("1"), D("1200")), (D("40"), D("95"))]
sub = sum(q * p for q, p in lines); disc = (sub * D("0.10")).quantize(D("0.01"), ROUND_HALF_UP)
net = sub - disc; vat = (net * D("0.18")).quantize(D("0.01"), ROUND_HALF_UP); total = net + vat
```
State whether prices include tax; currency on the total; round only at the line/total level.

## SOW specifics

Deliverables with acceptance criteria, change-request process, roles (RACI), milestones tied to
payments, warranty/support period, confidentiality and IP ownership (flag for legal review).

## Quotes (short form)

Header (your details, client, quote number `Q-2026-0042`, date, valid until), line items table,
totals, terms (payment, delivery, validity), acceptance line. Follow the organization's numbering
and template skill if one exists.

## Produce

Markdown → Word (`word-documents`) or PDF (`pdf-documents`) as requested; file name with client and
date (`Proposal - Northwind - 2026-10-07.pdf`).

## Checklist

- [ ] Every requirement in the brief is addressed (make a compliance table for RFPs).
- [ ] Math verified by code; totals consistent everywhere in the document.
- [ ] Out-of-scope and assumptions explicit.
- [ ] Dates, names, validity and payment terms correct.

## Done when

The client's need, plan, scope, timeline and price are clear, numbers are verified, and the
document is delivered in the requested format.
