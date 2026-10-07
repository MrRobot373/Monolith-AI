---
name: translation-localization
description: "Use when translating or localizing text, documents, websites, app strings or subtitles while keeping formatting and local formats."
category: Documents & writing
---

# Translation and localization

Translate meaning and intent, not words. Keep everything that isn't text exactly as it was.

## Before translating

- Source and target language and region (pt-BR vs pt-PT, es-ES vs es-MX, en-US vs en-GB, zh-CN vs zh-TW).
- Audience and register: formal (Sie/vous/usted) or informal (du/tu/tú), technical or general.
- Glossary: product names, brand terms and agreed translations. If none exists, create one as you
  go (`glossary.csv`: source, target, note) and keep it consistent.
- What must not be translated: brand and product names, code, placeholders, URLs, legal citations.

## While translating

- Keep structure identical: headings, lists, tables, Markdown/HTML tags, line breaks.
- Placeholders and variables stay untouched: `{name}`, `%s`, `{{count}}`, `<b>…</b>`, `:param`.
- Plurals and gender: use the target language's forms (ICU plural rules for app strings).
- Idioms and humor: find an equivalent, or say it plainly; don't translate literally.
- Units, dates, numbers and currency per locale:
  | Locale | Date | Number | Currency |
  |---|---|---|---|
  | en-US | 10/7/2026 | 1,234.56 | $1,234.56 |
  | en-GB | 07/10/2026 | 1,234.56 | £1,234.56 |
  | de-DE | 07.10.2026 | 1.234,56 | 1.234,56 € |
  | fr-FR | 07/10/2026 | 1 234,56 | 1 234,56 € |
  | hi-IN | 07/10/2026 | 1,234.56 (lakh grouping 1,23,456) | ₹1,234.56 |
  | ja-JP | 2026/10/07 | 1,234.56 | ¥1,235 |
  Convert prices only if asked; otherwise keep the original currency.
- Length: UI strings may expand 20–35% (German, French); flag strings likely to overflow buttons.
- Right-to-left languages (Arabic, Hebrew): text direction changes; keep numbers and code LTR.

## File types

- **JSON/YAML app strings**: translate values only, keep keys; validate the file parses afterwards
  (`python3 -c "import json; json.load(open('fr.json'))"`).
- **Subtitles (.srt/.vtt)**: keep timings and numbering; ≤ 42 characters per line, ≤ 2 lines.
- **Documents**: produce the same format (see `word-documents`, `pdf-documents`).
- **Websites**: also translate `<title>`, meta descriptions, `alt` text, and set `<html lang>`.

## Quality check

1. Re-read the translation alone: does it read naturally to a native speaker?
2. Compare side by side: nothing omitted or added; numbers, names, dates match.
3. Glossary terms used consistently; placeholders intact (count `{`/`%` in source vs target).
4. Mark uncertain passages for a native reviewer, especially legal, medical or marketing taglines.

## Done when

The translation is complete and natural, formatting and placeholders are intact, terminology is
consistent with the glossary, and uncertain spots are flagged for review.
