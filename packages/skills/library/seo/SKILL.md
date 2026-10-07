---
name: seo
description: "Use for SEO: keyword research, content briefs, optimizing pages, titles and meta descriptions, technical SEO audits, local SEO."
category: Business
---

# SEO

Write for the searcher first; make it easy for search engines to understand.

## Keyword research

1. Start from the business: products/services, customer problems, locations.
2. Expand with web search (`web_search`): look at what ranks for seed terms, "People also ask"
   style questions, related searches, competitor page titles. Without a keyword tool you can't get
   real volumes — say so, and estimate relative demand qualitatively.
3. Classify intent: informational ("how to…"), commercial ("best…", "vs"), transactional
   ("buy", "price", "near me"), navigational.
4. Group into topics: one primary keyword + close variants per page. Avoid two pages targeting the
   same intent (cannibalization).

Output a table: keyword · intent · page (existing or new) · priority · notes.

## Content brief

- Primary keyword and intent; the searcher's question in one sentence.
- Title idea, H1, outline (H2/H3) covering what top results cover plus something better
  (data, examples, a template, local detail).
- Questions to answer (FAQ), internal links to/from, CTA, target length (as long as needed, no padding).

## On-page checklist

- [ ] `<title>` ≤ ~60 characters, primary keyword near the start, brand at the end.
- [ ] Meta description 140–160 characters: benefit + CTA (it's an ad, not a ranking factor).
- [ ] One H1 matching intent; logical H2/H3 structure.
- [ ] Keyword and variants used naturally in the first 100 words and headings; no stuffing.
- [ ] Descriptive URL slug (`/accounting-services-pune`), lowercase, hyphens.
- [ ] Images: descriptive file names, `alt` text, compressed, width/height set.
- [ ] Internal links with descriptive anchor text; no broken links.
- [ ] Structured data where relevant (JSON-LD: Organization, LocalBusiness, Product, FAQPage, Article).
- [ ] Clear CTA; content answers the query better than the current top results.

## Technical audit (static HTML or a site folder)

Check with scripts over the HTML files: unique titles/descriptions (the `static-website` skill's
`check_links.py` reports missing ones), canonical tags, `robots` meta, `sitemap.xml` and
`robots.txt` present, `lang` attribute, mobile viewport meta, heading order, image `alt`, page
weight (large images/scripts), redirects/broken links. For live sites you can fetch public pages
with `web_fetch` and inspect them.

## Local SEO

Consistent name/address/phone (NAP) everywhere, a page per location/service area, LocalBusiness
schema with opening hours, encourage and answer reviews, Google Business Profile categories and
photos (recommend; you can't edit it from here).

## Done when

Recommendations are tied to specific pages and keywords with intent, on-page items are fixed or
listed precisely, and limitations (no search volume data) are stated.
