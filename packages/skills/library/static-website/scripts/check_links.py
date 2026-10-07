#!/usr/bin/env python3
"""Check a static site: broken internal links, missing assets, and pages without a title or
meta description. Usage: python3 check_links.py [site_folder]   (exit code 1 if problems)"""
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlparse


class Page(HTMLParser):
    def __init__(self):
        super().__init__()
        self.refs, self.ids, self.title, self.description, self._in_title = [], set(), "", False, False

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if "id" in a:
            self.ids.add(a["id"])
        for key in ("href", "src"):
            if a.get(key):
                self.refs.append((tag, a[key]))
        if tag == "title":
            self._in_title = True
        if tag == "meta" and a.get("name", "").lower() == "description" and a.get("content", "").strip():
            self.description = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data


def main(root: Path) -> int:
    pages = sorted(root.rglob("*.html"))
    if not pages:
        print(f"No HTML files under {root}")
        return 1
    parsed = {}
    for p in pages:
        h = Page()
        h.feed(p.read_text(encoding="utf-8", errors="replace"))
        parsed[p.resolve()] = h
    problems = []
    for p, h in parsed.items():
        rel = p.relative_to(root.resolve())
        if not h.title.strip():
            problems.append(f"{rel}: missing <title>")
        if not h.description:
            problems.append(f"{rel}: missing meta description")
        for tag, ref in h.refs:
            u = urlparse(ref)
            if u.scheme in ("http", "https", "mailto", "tel", "data", "javascript") or ref.startswith("//"):
                continue
            if ref == "#":
                problems.append(f"{rel}: placeholder link href=\"#\" on <{tag}>")
                continue
            target = p if not u.path else (p.parent / unquote(u.path)).resolve()
            if u.path.endswith("/") or (target.is_dir() if target.exists() else False):
                target = target / "index.html"
            if not target.exists():
                problems.append(f"{rel}: <{tag}> points to missing {ref}")
            elif u.fragment and target in parsed and u.fragment not in parsed[target].ids:
                problems.append(f"{rel}: anchor #{u.fragment} not found in {target.name}")
    if problems:
        print(f"{len(problems)} problem(s):")
        for line in problems:
            print(" -", line)
        return 1
    print(f"OK: {len(pages)} page(s), all internal links and assets resolve, titles and descriptions present.")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1] if len(sys.argv) > 1 else ".")))
