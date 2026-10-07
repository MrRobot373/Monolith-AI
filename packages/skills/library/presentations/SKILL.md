---
name: presentations
description: "Use when making a slide deck (.pptx): pitch, update, sales or training presentations; storyline and a script that builds the deck."
category: Documents & writing
---

# Presentations (.pptx)

A good deck is a story: each slide makes one point, and the titles alone tell the story.

## 1. Storyline first

Write the outline before any slide:
1. Audience and the decision or action you want from them.
2. The key message in one sentence.
3. 3–5 supporting points, each with its evidence (numbers, examples, charts).
4. The ask / next steps.

Common shapes:
- **Update**: Summary → Progress vs plan → Results → Risks/issues → Next steps → Asks.
- **Pitch**: Problem → Why now → Solution → How it works → Traction → Business model → Team → Ask.
- **Proposal**: Situation → Complication → Recommendation → Options compared → Plan & cost → Decision.
- **Training**: Goal → Concepts (one per slide) → Example → Practice → Recap.

## 2. Write the slides

- **Action titles**: a full sentence with the takeaway ("Churn fell to 2.1% after onboarding
  changes"), not a label ("Churn").
- One idea per slide; 3–5 bullets of ≤ 12 words; no paragraphs (put detail in speaker notes).
- Numbers over adjectives; show the comparison (vs last quarter, vs target).
- Charts made with `charts-visualization`, one message per chart.
- 10–15 slides for a 20-minute talk; appendix for backup detail.

## 3. Build the deck (script)

Write the outline as Markdown and build it with this skill's script:

```markdown
# Q3 Business Review
Acme Services · October 2026

## Revenue grew 18% to $412k, ahead of plan
- New customers: 46 (target 40)
- Expansion revenue +31% from upsells
  - Driven by the Pro plan launch
![](revenue_trend.png)
> Mention the one large deal that slipped to Q4.

## Section: Next quarter

## Three priorities for Q4
| Priority | Owner | Due |
|---|---|---|
| Launch EU pricing | Maya | Nov 15 |
```

```bash
python3 scripts/outline_to_pptx.py outline.md "Q3 Review.pptx" --accent 0072B2 --font Calibri
```

Supports: title slide, bullet slides (2 levels), an image or table beside bullets, section dividers
(`## Section: …`), speaker notes (`> …`), slide numbers, 16:9.

## 4. Refine with python-pptx (optional)

```python
from pptx import Presentation
prs = Presentation("Q3 Review.pptx")
for i, s in enumerate(prs.slides, 1):
    print(i, [sh.text_frame.text[:60] for sh in s.shapes if sh.has_text_frame])
```

Edit text runs, swap images, or add shapes there. When the person provides a branded template
(.pptx/.potx), open it with `Presentation("template.pptx")` and add slides using its layouts instead.

## Checks

- Read only the titles in order: do they tell the whole story?
- Every number matches the source data; units and periods on every chart.
- Nothing overflows: keep bullets short (the script wraps text but can't shrink it).
- Consistent fonts and colors; spell-check names.

## Done when

The deck file opens, titles carry the story, each slide has one point with evidence, notes hold the
detail, and you summarized the slide list.
