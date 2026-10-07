---
name: performance-optimization
description: "Use when code, an endpoint, a query or a web page is slow or heavy: profile, find the bottleneck, fix, measure before/after."
category: Software development
---

# Performance optimization

Measure, find the one thing that dominates, fix it, measure again. Never optimize by guessing.

## 1. Define the target

What is slow, for whom, how slow, and what is good enough? ("The /reports endpoint takes 8 s for
orgs with 50k invoices; target < 1 s.") Build a repeatable benchmark with realistic data size.

## 2. Measure

**Python**
```bash
python3 -m cProfile -s cumulative script.py | head -30
python3 -X importtime -c "import app" 2>&1 | sort -t'|' -k2 -n | tail   # slow imports
```
In code: `time.perf_counter()` around suspects; `tracemalloc` for memory.

**Node**
```bash
node --cpu-prof app.js        # writes .cpuprofile; summarize the hottest functions
node --heap-prof app.js
```
In code: `performance.now()` / `console.time("step")`.

**HTTP endpoint**: time it with `curl -o /dev/null -s -w "%{time_total}\n" URL` (run 5×, take the
median); log per-step timings inside the handler.

**Database**: `EXPLAIN (ANALYZE, BUFFERS)`; count queries per request (look for N+1).

**Web page**: bundle size (`npx vite build` output, `du -sh dist/assets/*`), image sizes
(`find . -name "*.png" -size +200k`), number of requests, render-blocking scripts.

## 3. Usual suspects and fixes

| Symptom | Fix |
|---|---|
| A query per item in a loop (N+1) | One query with `JOIN`/`IN (…)`, or the ORM's eager loading |
| Full table scans | Selective `WHERE` + matching composite index (see `sql-queries`) |
| Repeating the same expensive work | Cache with a clear key and expiry; memoize pure functions |
| O(n²) loops (list lookups inside loops) | Use a dict/set/map for lookups |
| Loading everything into memory | Stream/iterate, paginate, process in chunks |
| Sequential independent I/O | Run concurrently (`Promise.all`, `asyncio.gather`) with a limit |
| Large JSON responses | Paginate, select only needed fields, compress |
| Heavy frontend bundle | Code-split routes, remove unused deps, tree-shake, lazy-load below-the-fold |
| Large images | Right size, modern format (WebP/AVIF), `loading="lazy"`, explicit dimensions |
| Blocking the event loop (Node) | Move CPU work to a worker or a batch job |

Pandas: vectorize (`df["a"] * df["b"]`) instead of `apply`/row loops; read only needed columns
(`usecols`), set dtypes; `groupby` once and reuse.

## 4. Verify

Re-run the same benchmark. Report before → after with the median of several runs, and confirm tests
still pass and output is identical. Note trade-offs (cache staleness, memory for speed).

## Done when

The bottleneck was identified by measurement, the fix is targeted, before/after numbers are shown,
and behavior is unchanged.
