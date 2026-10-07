---
name: python-project
description: "Use when writing Python scripts, CLIs or projects: packaging, virtualenvs, typing, logging, error handling, files and CSV/JSON, tests."
category: Software development
---

# Python project

## Environment

- Check the version: `python3 --version`. Installed here by default: pandas, numpy, openpyxl,
  matplotlib, python-docx, python-pptx, reportlab, pypdf. Other packages need `pip install`, which
  uses the network and may ask for approval; install into a virtual environment for projects:
  `python3 -m venv .venv && . .venv/bin/activate && pip install -r requirements.txt`.
- Prefer the standard library when it does the job (csv, json, pathlib, datetime, argparse,
  sqlite3, urllib, statistics, re, logging).

## Layout

```
project/
  pyproject.toml
  src/project_name/__init__.py
  src/project_name/cli.py
  tests/test_core.py
  README.md
```

For a one-off script, a single file with a `main()` and `if __name__ == "__main__": main()` is fine.

```toml
[project]
name = "invoice-tools"
version = "0.1.0"
requires-python = ">=3.10"
dependencies = ["openpyxl>=3.1"]
[project.scripts]
invoice-tools = "invoice_tools.cli:main"
```

## Style

- Type hints on public functions; `from __future__ import annotations` for modern syntax on 3.9.
- `pathlib.Path` for files; always pass `encoding="utf-8"`; `newline=""` when writing CSV.
- Dataclasses for records; enums for fixed choices.
- f-strings; no mutable default arguments; `with` for files and connections.
- Money with `decimal.Decimal` (`Decimal("19.99")`), not float, when exactness matters.
- Dates: `datetime.now(timezone.utc)`; parse with `datetime.fromisoformat`.

## CLI template

```python
import argparse, logging, sys
from pathlib import Path

log = logging.getLogger("tool")

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Summarize invoices from a CSV file.")
    p.add_argument("csv", type=Path)
    p.add_argument("-o", "--out", type=Path, default=Path("summary.csv"))
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")
    if not args.csv.exists():
        log.error("File not found: %s", args.csv)
        return 2
    ...
    log.info("Wrote %s", args.out)
    return 0

if __name__ == "__main__":
    sys.exit(main())
```

## Errors

- Catch specific exceptions, at the boundary where you can do something useful (message, retry,
  skip a bad row with a warning). Don't `except Exception: pass`.
- Validate inputs early with clear messages naming the bad value and row.
- Exit codes: 0 success, 1 failure, 2 usage error.

## Quality checks

- `python3 -m py_compile file.py` for syntax; `python3 -m unittest` or `pytest -q` for tests.
- If available: `ruff check .`, `mypy src`.
- Run the script on a small real example and show the output.

## Done when

The code runs on a real example, handles bad input with clear messages, has tests for the core
logic, and the README (or your summary) says how to install and run it.
