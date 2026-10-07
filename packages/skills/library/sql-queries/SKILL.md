---
name: sql-queries
description: "Use when writing, fixing or speeding up SQL: joins, aggregations, window functions, reports, EXPLAIN plans, safe UPDATE/DELETE."
category: Software development
---

# SQL queries

## Write it right

1. Restate the question in one sentence, including the grain of the result ("one row per customer
   per month").
2. Know the schema: read the DDL/migrations or run `\d table` (psql) / `.schema table` (sqlite).
3. Build up step by step with CTEs, checking row counts after each step:

```sql
with paid as (
  select customer_id, date_trunc('month', paid_at) as month, sum(amount) as revenue
  from payment
  where paid_at >= date '2026-01-01' and paid_at < date '2026-07-01'
  group by 1, 2
)
select c.name, p.month, p.revenue,
       p.revenue - lag(p.revenue) over (partition by p.customer_id order by p.month) as change
from paid p
join customer c on c.id = p.customer_id
order by c.name, p.month;
```

## Correctness traps

- **Join fan-out**: joining two one-to-many tables multiplies rows; aggregate each side in its own
  CTE first, then join. Compare `count(*)` before and after a join.
- **NULLs**: `col = NULL` is never true (use `IS NULL`); `NOT IN (subquery with NULL)` returns
  nothing (use `NOT EXISTS`); `count(col)` skips NULLs, `count(*)` doesn't; `sum` of nothing is NULL
  (`coalesce(sum(x), 0)`).
- **Date ranges**: half-open intervals `>= start AND < next_start`, never `BETWEEN` on timestamps.
  Mind time zones: `timestamptz` compared in UTC unless converted (`at time zone 'Europe/Berlin'`).
- **Integer division**: `1/2 = 0`; cast (`1.0 * a / b` or `a::numeric / b`) and guard zero with `nullif(b, 0)`.
- **LEFT JOIN + WHERE on the right table** turns it into an inner join; put that condition in `ON`.
- **DISTINCT** hiding a bad join: find the duplication instead.
- **GROUP BY**: every non-aggregated column must be grouped (Postgres enforces; MySQL may not).

## Window functions cheat sheet

`row_number()` (dedupe: keep `= 1`), `rank()`, `lag/lead` (period-over-period),
`sum(x) over (partition by k order by d rows unbounded preceding)` (running total),
`avg(x) over (order by d rows between 6 preceding and current row)` (7-row moving average),
`percentile_cont(0.5) within group (order by x)` (median, an aggregate).

## Performance

1. `EXPLAIN (ANALYZE, BUFFERS) <query>` in Postgres (`EXPLAIN QUERY PLAN` in SQLite). Look for
   sequential scans on big tables, row estimates far from actual, sorts spilling to disk, nested loops
   over many rows.
2. Fix in this order: add a selective `WHERE`; make predicates sargable (no functions on indexed
   columns: `created_at >= …` not `date(created_at) = …`); add or adjust a composite index; rewrite
   correlated subqueries as joins/CTEs; paginate with keyset (`WHERE (created_at, id) < (…)`) instead
   of large `OFFSET`.
3. Re-run EXPLAIN and report before/after timings.

## Changing data safely

- Run the `SELECT` with the same `WHERE` first and check the count.
- Wrap in a transaction: `BEGIN; UPDATE …; SELECT …(check); COMMIT;` (or `ROLLBACK`).
- Large updates in batches (`… WHERE id IN (SELECT id … LIMIT 5000)`) to avoid long locks.
- Never run destructive statements against production without the person's explicit go-ahead.

## Trying queries locally

`sqlite3` is often available for quick checks; for CSV data you can load it with Python:
`python3 -c "import pandas as pd, sqlite3; con=sqlite3.connect('t.db'); pd.read_csv('sales.csv').to_sql('sales', con)"`.

## Done when

The query answers the stated question at the stated grain, row counts were sanity-checked, edge
cases (NULLs, empty periods, ties) are handled, and for slow queries you showed the plan and the fix.
