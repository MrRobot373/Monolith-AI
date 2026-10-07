#!/usr/bin/env python3
"""WCAG 2.x contrast ratio between colors.
Usage:
  python3 contrast.py "#777777" "#ffffff"            one pair
  python3 contrast.py --css styles.css              every color/background pair declared in the same rule
"""
import re
import sys


def parse(c: str):
    c = c.strip().lower()
    named = {"white": "#ffffff", "black": "#000000"}
    c = named.get(c, c)
    if m := re.fullmatch(r"#([0-9a-f]{3})", c):
        c = "#" + "".join(ch * 2 for ch in m.group(1))
    if m := re.fullmatch(r"#([0-9a-f]{6})([0-9a-f]{2})?", c):
        h = m.group(1)
        return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))
    if m := re.fullmatch(r"rgba?\(\s*(\d+)[ ,]+(\d+)[ ,]+(\d+).*\)", c):
        return tuple(int(m.group(i)) for i in (1, 2, 3))
    raise ValueError(f"unsupported color {c!r} (use #rgb, #rrggbb or rgb())")


def luminance(rgb):
    def ch(v):
        v /= 255
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4

    r, g, b = (ch(v) for v in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def ratio(a, b):
    la, lb = sorted((luminance(parse(a)), luminance(parse(b))), reverse=True)
    return (la + 0.05) / (lb + 0.05)


def verdict(r):
    return ", ".join(
        f"{name} {'pass' if r >= need else 'FAIL'}"
        for name, need in (("normal text AA 4.5", 4.5), ("large text/UI AA 3.0", 3.0), ("AAA 7.0", 7.0))
    )


def css_pairs(path):
    text = re.sub(r"/\*.*?\*/", "", open(path, encoding="utf-8").read(), flags=re.S)
    variables = dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", text))
    resolve = lambda v: variables.get(m.group(1), v).strip() if (m := re.match(r"var\((--[\w-]+)\)", v.strip())) else v.strip()
    for selector, body in re.findall(r"([^{}]+)\{([^{}]*)\}", text):
        fg = re.search(r"(?<![-\w])color\s*:\s*([^;]+);", body)
        bg = re.search(r"background(?:-color)?\s*:\s*([^;]+);", body)
        if fg and bg:
            yield selector.strip(), resolve(fg.group(1)), resolve(bg.group(1).split()[0])


if __name__ == "__main__":
    args = sys.argv[1:]
    if len(args) == 2 and args[0] == "--css":
        bad = 0
        for sel, fg, bg in css_pairs(args[1]):
            try:
                r = ratio(fg, bg)
            except ValueError:
                continue
            bad += r < 4.5
            print(f"{r:5.2f}:1  {sel}  ({fg} on {bg})  {verdict(r)}")
        sys.exit(1 if bad else 0)
    if len(args) != 2:
        print(__doc__)
        sys.exit(2)
    r = ratio(args[0], args[1])
    print(f"{r:.2f}:1 — {verdict(r)}")
    sys.exit(0 if r >= 4.5 else 1)
