---
name: database-migrations
description: "Use when changing an existing database schema: migrations (Prisma, Drizzle, Alembic, Django…), backfills, zero-downtime changes."
category: Software development
---

# Database migrations

A migration runs against data you can't see. Make it safe to run, safe to retry, and easy to undo.

## Workflow

1. Find the project's migration tool and conventions (`migrations/` folder, `drizzle.config`,
   `alembic.ini`, `prisma/schema.prisma`). Generate migrations with the tool when it can; then read
   the generated SQL.
2. Change the schema source (models/schema file) and generate, or write SQL by hand following the
   existing file naming and numbering.
3. Apply on a scratch database (or SQLite for portable SQL), then run the app's tests.
4. Describe in the summary: what changes, whether it locks tables, how long it may take on large
   tables, and how to roll back.

## Safe patterns (zero-downtime)

| Change | Do | Avoid |
|---|---|---|
| Add a column | Add as NULLable or with a constant default (fast in Postgres 11+), backfill in batches, then `SET NOT NULL` | Adding NOT NULL without default on a big table |
| Rename a column | Expand–contract: add new column, write both, backfill, switch reads, drop old later | `RENAME` while old app versions still run |
| Change a type | New column + backfill + switch | In-place `ALTER TYPE` on large tables (rewrites, locks) |
| Add an index (Postgres) | `CREATE INDEX CONCURRENTLY` (outside a transaction) | Plain `CREATE INDEX` on busy tables |
| Add a foreign key | `ADD CONSTRAINT … NOT VALID`, then `VALIDATE CONSTRAINT` | Validating during the add on big tables |
| Drop a column/table | Stop using it in code first, deploy, then drop in a later migration | Dropping in the same release that stops using it |

## Backfills

```sql
-- Run repeatedly until it updates 0 rows; each batch is short.
update invoice set total_cents = round(total * 100)
where id in (select id from invoice where total_cents is null limit 5000);
```

Make backfills idempotent (only touch rows not yet done) and resumable.

## Data safety rules

- Never drop or truncate data without the person's explicit confirmation and a backup plan.
- Write the down/rollback migration when the tool supports it; when a change can't be undone
  (dropping data), say so plainly.
- Keep schema migrations and large data migrations separate.
- Seed or reference data goes in its own migration with `ON CONFLICT DO NOTHING` / upserts.

## Checklist before finishing

- [ ] Generated SQL reviewed; nothing unexpected (drops, renames detected as drop+add).
- [ ] Runs on an empty database and on one with existing rows.
- [ ] Locks and duration considered for large tables.
- [ ] App code works both before and after the migration during deploy (for expand–contract steps).
- [ ] Tests pass; migration file names follow the project's order.

## Done when

The migration applies cleanly, the risky parts are called out with how to run them, and rollback is
written or its absence explained.
