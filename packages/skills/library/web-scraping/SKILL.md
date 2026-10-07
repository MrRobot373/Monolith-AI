---
name: web-scraping
description: "Use when extracting data from web pages into CSV/JSON/Excel: polite fetching, parsing HTML tables and lists, pagination, cleanup."
category: Software development
---

# Web scraping and data extraction

## Ground rules

- Prefer an official API or a downloadable export if one exists (check the site for "API",
  "export", "download CSV").
- Respect the site: read `robots.txt` and terms; identify yourself with a User-Agent; one request at
  a time with a pause (1–2 s); stop on 429/403. Don't scrape behind logins or paywalls you weren't
  given access to, and don't collect personal data you don't need.
- Fetching pages uses the network: in tasks, `curl`/Python requests may ask the person to approve.
  `web_fetch` is fine for reading a single public page as text.

## Fetch

```python
import time, urllib.request

def get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (compatible; AatmiqBot/1.0)"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode(r.headers.get_content_charset() or "utf-8", errors="replace")
```

Save raw HTML to `raw/page-001.html` first, then parse from the files: you can re-parse without
re-downloading.

## Parse

**Tables** — pandas reads every `<table>` (needs lxml or html5lib; lxml is usually installed):
```python
import pandas as pd
tables = pd.read_html("raw/page-001.html")   # list of DataFrames
df = tables[0]
```

**Other structures** — the standard library parser:
```python
from html.parser import HTMLParser

class Cards(HTMLParser):
    def __init__(self):
        super().__init__(); self.rows, self._cur, self._field = [], None, None
    def handle_starttag(self, tag, attrs):
        a = dict(attrs); cls = a.get("class", "")
        if tag == "div" and "product-card" in cls: self._cur = {}
        elif self._cur is not None and tag in ("h3", "span") and cls in ("name", "price"): self._field = cls
        elif self._cur is not None and tag == "a" and "href" in a: self._cur.setdefault("url", a["href"])
    def handle_endtag(self, tag):
        if tag == "div" and self._cur and "name" in self._cur: self.rows.append(self._cur); self._cur = None
        self._field = None
    def handle_data(self, data):
        if self._cur is not None and self._field: self._cur[self._field] = self._cur.get(self._field, "") + data.strip()
```

Inspect the HTML first (`grep -o 'class="[^"]*"' raw/page-001.html | sort | uniq -c | sort -rn | head`)
to find the right classes instead of guessing.

**JSON in the page** — many sites embed data: look for `<script type="application/ld+json">` or
`__NEXT_DATA__` and parse that with `json.loads`; it's more reliable than HTML.

## Pagination

Follow the site's "next" link or a page parameter until no new items appear; cap the number of pages;
de-duplicate by a stable key (URL or id).

## Clean and save

Strip whitespace, normalize prices (`"$1,299.00"` → `1299.00`), parse dates, make URLs absolute
(`urllib.parse.urljoin`), drop duplicates. Save as CSV (`df.to_csv("products.csv", index=False)`) or
Excel (see `excel-spreadsheets`). Report counts: pages fetched, items found, items dropped and why.

## Done when

The data is complete for the requested scope, cleaned and saved, the counts are reported, the
script can be re-run, and you noted any pages that failed.
