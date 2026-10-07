---
name: static-website
description: "Use when building a business, marketing or landing website as static HTML/CSS/JS: shared header/footer, SEO tags, forms, link check."
category: Software development
---

# Static website

A fast, accessible multi-page site with no build step. Good for company sites, landing pages,
event pages and portfolios.

## Plan the site

Write the plan with your todo tool before creating files:

1. Pages and their purpose (Home, About, Services/Pricing, Contact are typical).
2. The one action each page should lead to (book a call, buy, sign up).
3. Brand: name, 1 accent color, 1–2 fonts, tone of voice. If the person gave none, choose calm
   defaults and say so.
4. Content per section. Write real copy, not lorem ipsum; mark anything you invented (prices,
   names, addresses) as placeholder in your summary.

## Files

```
index.html  about.html  services.html  contact.html
css/styles.css           one stylesheet, tokens at the top
js/main.js               small, progressive enhancement only
img/                     only if the person provided images (otherwise CSS/SVG)
favicon.svg
```

## Every page

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Page title — Brand</title>
  <meta name="description" content="One sentence, 140–160 characters, about this page.">
  <link rel="icon" href="favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="css/styles.css">
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  <header>…logo + nav (current page has aria-current="page")…</header>
  <main id="main">…</main>
  <footer>…contact, links, © year…</footer>
  <script src="js/main.js" defer></script>
</body>
</html>
```

- Same header and footer markup on every page (copy exactly; update `aria-current`).
- Add Open Graph tags (`og:title`, `og:description`) on the home page.
- Footer year: use the current year.

## CSS approach

```css
:root {
  --bg: #0f1115; --surface: #171a21; --text: #e8eaf0; --muted: #a0a6b4;
  --accent: #ff6a3d; --radius: 12px; --space: 1rem;
  --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
```

- Mobile first; one or two breakpoints (`min-width: 720px`, `1080px`).
- Header: flex row with `justify-content: space-between`; the nav collapses into a menu button on
  phones (a `<button aria-expanded>` toggled by JS, not a bare checkbox).
- Wide tables go in `<div class="table-wrap">` with `overflow-x: auto`.
- Don't rely on external fonts or images being reachable; system fonts are fine.

## Interactive pieces (js/main.js)

- Menu toggle (update `aria-expanded`), FAQ accordions (`<details><summary>` needs no JS at all),
  pricing toggles, form validation with inline messages.
- Prices or numbers computed by JS must be correct: write the formula once and check two cases by
  hand (e.g. yearly = monthly × 12 × (1 − discount)).
- The site must still read fine with JS off.

## Contact form

Static sites can't send email by themselves. Use a `mailto:` link, or a form posting to a service
the person names. Validate inline, keep input on errors, show a success message.

## Check before finishing

1. Links and assets: `python3 scripts/check_links.py <site folder>` (in this skill's folder). It
   reports broken internal links, missing CSS/JS/images and pages missing a title or description.
2. Look for leftovers: `grep -rn "lorem\|TODO\|href=\"#\"" --include=*.html .`
3. Check contrast of text colors with the `accessibility-audit` skill.
4. Re-read each page's copy once for typos and consistent names, prices and hours.
5. Delete any helper files you created that aren't part of the site.

## Done when

All pages share the header/footer, every link works, each page has a unique title and description,
the layout works at 360 px and desktop, and your summary lists the pages, the placeholders the
person must replace, and how to publish (any static host: upload the folder).
