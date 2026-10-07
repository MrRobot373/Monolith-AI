---
name: web-research
description: "Use when a question needs current or external information from the web: good searches, source checking, cited answers."
category: Business
---

# Web research

Search well, read the actual sources, cite what you used, and say what you couldn't confirm.

## 1. Plan the questions

Break the request into 2–5 concrete sub-questions. For each, decide what a good source would be
(official site, regulator, statistics office, peer-reviewed study, reputable news, documentation).

## 2. Search

- `web_search` with specific queries: entity names, exact terms in quotes, year, location, file
  types ("annual report 2025 pdf"), site filters if the engine supports them.
- Run several queries with different wording; one query rarely covers a topic.
- Use `web_fetch` to open the most promising results and read the relevant part. Search snippets
  alone are not enough for important facts.
- For intranet or local addresses, `web_fetch` refuses private networks; use `curl` (it asks the
  person for approval) or ask for the file.

## 3. Judge sources

| Prefer | Be careful with |
|---|---|
| Primary sources (company pages, laws, official statistics, original papers) | Content farms, unsourced listicles, AI-generated pages |
| Recent and dated | Undated pages, old data presented as current |
| Named authors/organizations with expertise | Anonymous claims, affiliate "reviews" |
| Agreement across independent sources | A single source for a surprising claim |

When sources conflict, report both with dates and explain which you trust more and why.

## 4. Record as you go

For every fact you'll use: the claim, the source title, publisher, date, URL. Quote exact numbers and
short phrases rather than paraphrasing figures.

## 5. Answer

- Lead with the direct answer, then supporting detail.
- Cite inline with numbered references `[1]` and list sources at the end with titles and links.
  Only cite pages you actually opened and that support the claim.
- Mark uncertainty: "As of Sep 2026 per [2]; I couldn't confirm the 2026 figure."
- Never fabricate sources, quotes, statistics or URLs. If you didn't find it, say so and suggest
  where it might be found.

## Example

> Northwind launches the Zephyr X2 on 14 March 2027 at $2,450 [1]; reviewers report a 120 km range
> per charge [2].
>
> Sources
> 1. "Northwind announces the Zephyr X2 e-bike", news.example.com, Oct 2026 — https://news.example.com/…
> 2. "Zephyr X2 first ride", reviews.example.org — https://reviews.example.org/…

## Done when

Each sub-question is answered or explicitly marked unknown, facts are cited to sources you read,
conflicts are explained, and the answer comes first.
