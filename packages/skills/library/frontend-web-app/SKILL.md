---
name: frontend-web-app
description: "Use when building or changing a web frontend (HTML/CSS/JS, React, Vue): pages, components, forms, responsive layout, and verifying the build."
category: Software development
---

# Frontend web app

Build interfaces that work on every screen size, are accessible, and are verified before you say
they're done.

## 1. Understand before you build

- Read the existing code first: `package.json` (framework, scripts, versions), the router, one or two
  existing components, the styling approach (CSS modules, Tailwind, styled-components, plain CSS).
  Match what is there. Don't introduce a second styling system or state library.
- If there is no project yet, pick the smallest thing that fits:
  - A few static pages, no build step wanted → plain HTML + one CSS file + one JS file (see the
    `static-website` skill).
  - An interactive app → Vite + React + TypeScript (`npm create vite@latest app -- --template react-ts`)
    unless the person asks otherwise. Installing packages needs network access, which may ask for
    approval.
- Write down the screens, the data each one needs, and the states each one has (loading, empty,
  error, success). Put this in your plan.

## 2. Structure

```
src/
  components/      reusable pieces (Button, Modal, Field) — no data fetching
  features/<area>/ screens and their hooks, grouped by feature
  lib/             api client, formatting, helpers
  styles/          tokens (colors, spacing, type scale) and global CSS
```

- One component per file; name files after the component.
- Keep components small: if a file passes ~200 lines or does two jobs, split it.
- Data fetching lives in hooks or loaders, not deep inside presentational components.
- Put magic numbers (colors, spacing, breakpoints) in tokens: CSS custom properties or the theme.

## 3. Layout and responsiveness

- Mobile first: write the narrow layout, then add `@media (min-width: 640px | 1024px)` rules.
- Use flexbox/grid with `gap`; avoid fixed pixel widths on containers. `max-width` + `margin-inline: auto` for content.
- Tables and wide content get their own `overflow-x: auto` wrapper so the page never scrolls sideways.
- Images: `max-width: 100%; height: auto;` and explicit `width`/`height` attributes to avoid layout shift.
- Tap targets at least 44×44 px on touch layouts.
- Test widths mentally (and in CSS) at 360, 768, 1280 px.

## 4. Forms

- Every input has a `<label for>` (or `aria-label` when visually hidden). Placeholder is not a label.
- Use the right `type` (`email`, `tel`, `number`, `date`) and `autocomplete` attributes.
- Validate on submit and on blur; show the message next to the field (`aria-describedby`), not in
  `alert()`. Keep what the person typed when validation fails.
- Disable the submit button while sending; show success and error states.

## 5. State and data

- Derive instead of duplicating state. Lift state only as high as needed.
- Server data: one source of truth (a query library or a small hook with loading/error/data).
- Handle every state: loading skeleton, empty state with a next action, error with retry.
- Never put secrets (API keys) in frontend code; they ship to every visitor.

## 6. Accessibility (minimum bar)

- Semantic elements: `button` for actions, `a` for navigation, headings in order, `main`/`nav`/`footer`.
- Visible focus styles; everything works with the keyboard (Tab, Enter, Escape for dialogs).
- Text contrast ≥ 4.5:1 (use the `accessibility-audit` skill's contrast script).
- Images have meaningful `alt` (empty `alt=""` for decorative ones).

## 7. Verify (no browser here, so be thorough)

1. Build or type-check: `npm run build` / `npx tsc --noEmit`. Fix every error and warning you caused.
2. Lint if the project has it: `npm run lint`.
3. Run unit tests if present: `npm test -- --run`.
4. For static sites, check links and assets: `python3 <base dir>/../static-website/scripts/check_links.py .`
   (or write a small script that verifies every `href`/`src` resolves).
5. Grep for leftovers: `grep -rn "console.log\|TODO\|debugger" src/`.
6. Re-read each changed file once, top to bottom, as a reviewer would.

## Pitfalls

- Inventing APIs of a library version you haven't checked: read `node_modules/<pkg>/package.json`
  for the version and follow that version's docs.
- Fixed heights that cut off text when it wraps or is translated.
- `alert()`/`confirm()` for messages: use inline UI.
- Leaving helper scripts or debug files in the project: delete what you created only to check things.

## Done when

- It builds with no new errors, every screen has loading/empty/error states, it works at 360 px and
  1280 px wide, it is keyboard accessible, and you've summarized what changed and how to run it.
