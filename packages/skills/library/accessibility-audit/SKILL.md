---
name: accessibility-audit
description: "Use when checking or fixing accessibility (WCAG 2.2 AA): contrast, keyboard use, labels, headings, forms. Has a contrast-ratio script."
category: Software development
---

# Accessibility audit (WCAG 2.2 AA)

Find the problems that block real people, fix them, and report what you checked.

## How to audit without a browser

Work from the source (HTML templates, components, CSS). Go page by page or component by component
and run the checklist below. Use `grep` to sweep for patterns across the project, for example:

```bash
grep -rn "<img" --include=*.{html,jsx,tsx,vue} . | grep -v "alt="          # images without alt
grep -rn "onClick" --include=*.{jsx,tsx} . | grep -E "<(div|span)"          # clickable non-buttons
grep -rn "outline: *none\|outline: *0" --include=*.{css,scss} .             # removed focus rings
grep -rn "placeholder=" --include=*.{html,jsx,tsx} .                        # check each has a label
```

## Checklist

**Perceivable**
- [ ] Text contrast ≥ 4.5:1; large text (≥ 24 px or 19 px bold) and icons/borders of controls ≥ 3:1.
      Check pairs with `python3 scripts/contrast.py "#777777" "#ffffff"` (this skill's folder).
- [ ] Every meaningful image has `alt` describing its purpose; decorative ones have `alt=""`.
- [ ] Information isn't conveyed by color alone (errors have text/icons too).
- [ ] Videos have captions; audio has a transcript.
- [ ] Content reflows at 320 px wide without horizontal scrolling; text can be zoomed to 200%.

**Operable**
- [ ] Everything works with the keyboard; focus order follows the visual order; no keyboard traps.
- [ ] Focus is visible (never `outline: none` without a replacement); focus isn't hidden behind sticky headers.
- [ ] Interactive targets are at least 24×24 px (44×44 recommended on touch).
- [ ] Dialogs move focus inside, trap it while open, close on Escape, return focus when closed.
- [ ] "Skip to content" link on pages with navigation.
- [ ] No content flashes more than 3 times per second; respect `prefers-reduced-motion`.

**Understandable**
- [ ] `<html lang="…">` is set.
- [ ] Every form field has a visible label tied with `for`/`id`; required fields are marked in text.
- [ ] Errors name the field and how to fix it, and are linked with `aria-describedby`.
- [ ] Consistent navigation and naming across pages.

**Robust**
- [ ] Native elements first (`button`, `a`, `input`, `select`, `details`). ARIA only to fill gaps,
      and every ARIA role has the keyboard behavior it promises.
- [ ] Headings form an outline (one `h1`, no skipped levels used for styling).
- [ ] Landmarks: `header`, `nav`, `main`, `footer`.
- [ ] Icon-only buttons have an accessible name (`aria-label`).
- [ ] Status messages (saved, error) are announced (`role="status"` / `aria-live="polite"`).

## Report format

| # | Severity | Where | Problem | WCAG | Fix |
|---|---|---|---|---|---|
| 1 | Blocker | Checkout form | Card field has no label | 3.3.2 | Add `<label for="card">Card number</label>` |

Severity: **Blocker** (someone can't complete the task), **Major** (hard or confusing), **Minor**.
Lead with blockers. When asked to fix, fix blockers and majors, then re-run the checks.

## Done when

Every page or component in scope went through the checklist, contrast pairs were measured (not
guessed), fixes are applied or listed with exact code, and you state what wasn't checkable without a
browser or screen reader.
