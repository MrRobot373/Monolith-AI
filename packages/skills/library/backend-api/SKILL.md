---
name: backend-api
description: "Use when designing or building a backend/REST API (Node, Python, Go): endpoints, validation, errors, auth, pagination, testing with curl."
category: Software development
---

# Backend API

## Design the contract first

Write the endpoints as a table before coding:

| Method | Path | Body | Success | Errors |
|---|---|---|---|---|
| GET | /invoices?status=open&cursor=… | – | 200 `{ items, nextCursor }` | 400 |
| POST | /invoices | `{ customerId, lines[] }` | 201 invoice + `Location` | 400, 404 customer, 409 |
| GET | /invoices/{id} | – | 200 invoice | 404 |
| PATCH | /invoices/{id} | partial fields | 200 invoice | 400, 404, 409 |
| DELETE | /invoices/{id} | – | 204 | 404, 409 |

Rules:
- Plural nouns for collections, ids in the path, filters in the query string. Verbs only for
  actions that aren't CRUD: `POST /invoices/{id}/send`.
- Status codes: 200 OK, 201 created, 204 no content, 400 invalid input, 401 not signed in,
  403 not allowed, 404 not found (also for things the caller may not see), 409 conflict/state,
  422 if the project uses it for validation, 429 rate limited, 500 bug.
- One error shape everywhere: `{ "error": "Human-readable message", "code": "invoice_locked", "details": … }`.
- Pagination: cursor-based for feeds and large tables (`?cursor=&limit=`, max limit enforced);
  offset is fine for small admin lists. Always return the next cursor or `null`.
- Times in UTC ISO 8601; money as integer minor units or decimal strings, with a currency.
- PATCH merges; PUT replaces. Make retried POSTs safe with an `Idempotency-Key` header where it matters.

## Implementation checklist

- [ ] **Validate every input at the edge** with a schema (zod, pydantic, joi). Reject unknown
      fields. Limit string lengths, array sizes, numeric ranges.
- [ ] **Authenticate, then authorize per resource**: check the caller owns or may see *this* record,
      not just that they're logged in. Return 404 for records they may not see.
- [ ] **Database**: parameterized queries/ORM only (never string-built SQL). Transactions for
      multi-step writes. Indexes for the filters you added (see `sql-queries`).
- [ ] **Errors**: throw typed errors in services; one error handler maps them to responses. Never
      leak stack traces or SQL to clients; log them server-side with a request id.
- [ ] **Config** from environment variables, validated at startup. Secrets never in code or logs.
- [ ] **Limits**: request body size, timeouts on outgoing calls, rate limits on auth endpoints.
- [ ] **Logging**: one structured line per request (method, path, status, duration, user id). No
      passwords, tokens or full card numbers.

## Layering

```
routes/      HTTP only: parse + validate input, call a service, shape the response
services/    business rules; no HTTP objects
db/ or repo/ queries
```

## Try it

Start the server in the background (`bash` with `run_in_background`) and exercise it:

```bash
curl -s -X POST localhost:3000/invoices -H 'content-type: application/json' \
  -d '{"customerId":"c1","lines":[{"desc":"Hours","qty":10,"price":120}]}' | python3 -m json.tool
curl -s -o /dev/null -w "%{http_code}\n" localhost:3000/invoices/does-not-exist   # expect 404
```

Check the unhappy paths too: missing fields (400), wrong owner (404), duplicate (409).

## Tests

Write integration tests per endpoint (supertest, fastify.inject, FastAPI TestClient, httptest):
happy path, validation error, not found, permission denied, and one edge case (empty list, max
limit). Use a test database or transactions rolled back per test.

## Done when

The contract table matches the code, every endpoint validates input and checks permissions, tests
cover success and failure paths and pass, and you documented how to run it (env vars, commands).
For a formal spec, follow `api-documentation`.
