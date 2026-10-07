---
name: ui-ux-design
description: "Use when designing or improving a UI or user flow: layout, visual style, design tokens, component states, wireframes, design reviews."
category: Software development
---

# UI/UX design

Good interfaces are clear first and beautiful second. Design for the task the person is doing.

## 1. Start from the job, not the screen

Answer in a few lines before drawing anything:
- Who uses it, on what device, how often, how expert are they?
- What is the one primary task on this screen? What must they see first?
- What can go wrong (empty data, errors, slow network, long names, 500 rows)?

## 2. Flow

- List the steps a person takes to finish the task. Remove steps; merge screens that are always used
  together. Each extra click or field needs a reason.
- Defaults: pre-fill what you can, remember previous choices, make the common path the easy path.
- Destructive actions: confirm with the consequence spelled out ("Delete 3 invoices? This can't be
  undone."), or better, allow undo.

## 3. Layout and hierarchy

- One primary action per view, visually strongest (filled button). Secondary actions are quieter
  (outline/ghost). Destructive is red, and never the default.
- Group related things; separate groups with space before lines or boxes.
- Align to a grid. Use a spacing scale and only its values: 4, 8, 12, 16, 24, 32, 48, 64 px.
- Reading order: what matters first goes top-left (in LTR languages). Keep line length 50–75 characters.

## 4. Visual system (tokens)

Define these once (CSS variables or theme) and use nothing else:

| Token | Typical values |
|---|---|
| Type scale | 12, 14, 16, 20, 24, 32, 40 px; 1–2 font families; weights 400/500/600 |
| Colors | background, surface, border, text, muted text, one accent, success, warning, danger |
| Radius | 6 or 8 for controls, 12–16 for cards |
| Shadow | none or one soft level; prefer borders in dense UIs |
| Motion | 120–200 ms ease-out for state changes; nothing that blocks input |

- Contrast: body text ≥ 4.5:1, large text and UI parts ≥ 3:1 (check with the `accessibility-audit` skill).
- Dark mode: don't invert; define a second palette with the same token names.
- Color is never the only signal (add an icon or text to errors and statuses).

## 5. Components and their states

For every interactive component, design all states: default, hover, focus (visible ring), active,
disabled, loading, error, success. For every data view: loading (skeleton), empty (explain + next
action), error (what happened + retry), partial, and overflow (long text truncates with a tooltip,
lists paginate or virtualize).

## 6. Copy is design

- Buttons say what they do: "Save invoice", not "OK". Headings say where you are.
- Errors say what happened and what to do: "Card declined. Try another card or contact your bank."
- Sentence case, short words, no jargon, no blame.

## 7. Deliverables

Pick what the person needs:
- **Wireframe**: a single HTML file with grey boxes and real labels, or an ASCII/Mermaid sketch in
  Markdown, plus notes per screen.
- **Style guide**: tokens table + component examples in an HTML page.
- **Design review**: a table of issues with severity (blocker/major/minor), where, why it matters,
  and the fix. Start with the 3 most important.
- **Implementation**: follow the `frontend-web-app` skill.

## Heuristic checklist (for reviews)

1. Is the system status visible (loading, saved, failed)?
2. Does it use the person's words, not internal terms?
3. Can they undo or cancel?
4. Is it consistent (same thing looks and behaves the same)?
5. Does it prevent errors (constraints, sensible defaults) before reporting them?
6. Is the next step obvious without reading instructions?
7. Is it efficient for repeat use (keyboard shortcuts, bulk actions)?
8. Is it minimal (nothing competes with the primary task)?
9. Are errors helpful?
10. Is help available where it's needed?

## Done when

The primary task is obvious, all states are designed, tokens are consistent, contrast passes, and
you explained the key decisions in a few bullets.
