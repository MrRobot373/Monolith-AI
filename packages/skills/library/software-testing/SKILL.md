---
name: software-testing
description: "Use when writing or improving automated tests (pytest, unittest, Jest, Vitest, Go): test cases, mocks, fixtures, flaky tests."
category: Software development
---

# Software testing

Tests exist to catch real bugs and let people change code with confidence.

## Use what the project uses

Find the runner and conventions first: `package.json` scripts, `pytest.ini`/`pyproject.toml`,
`vitest.config`, the `tests/` or `__tests__/` layout, naming (`test_*.py`, `*.test.ts`). Copy the
style of an existing good test. If there are no tests, pick the standard for the language
(pytest or unittest, Vitest or Jest, `go test`). `python3 -m unittest` works with no installs.

## Choosing cases

For each unit of behavior, cover:
1. The main success path with a realistic input.
2. Boundaries: empty, one, many; zero, negative, maximum; first/last day of a month; exact limit.
3. Invalid input and error paths (and that errors are the right type/message).
4. Anything that was a bug before (regression tests named after the bug).

Name tests as sentences about behavior: `test_discount_never_makes_price_negative`,
`it("rejects an expired coupon")`.

## Structure

Arrange–Act–Assert, one behavior per test:

```python
def test_final_price_applies_discount_before_tax():
    price = final_price(200, discount=0.25, rate=0.18)   # act
    assert price == 177.0                                 # assert
```

```ts
it("returns 404 for an invoice in another organization", async () => {
  const res = await app.inject({ method: "GET", url: `/invoices/${otherOrgInvoice.id}`, headers: auth(alice) });
  expect(res.statusCode).toBe(404);
});
```

- Assert on outcomes the user cares about (return values, HTTP responses, rows written), not on
  private implementation details.
- Use factories/fixtures for test data with sensible defaults; override only what the test is about.
- Keep tests independent: each sets up its own data; no ordering dependencies.

## Test levels

| Level | What | Notes |
|---|---|---|
| Unit | pure functions, business rules | fast, many, no I/O |
| Integration | API handlers with a real (test) database, file and queue adapters | the best bug-per-test value for backends |
| End-to-end | full user flows in a browser (Playwright, Cypress) | few, critical paths only |

## Mocks

- Mock what you don't own and what is slow or non-deterministic: external HTTP APIs, clocks,
  randomness, email. Don't mock your own database layer in integration tests.
- Freeze time (`freezegun`, `vi.useFakeTimers()`), seed randomness.
- Prefer fakes (in-memory implementations) over deep mock chains.

## Flaky tests

Typical causes: shared state between tests, real time or timers, ordering assumptions on unordered
results, network calls, race conditions with async work not awaited. Fix the cause; never just add
retries or sleeps, and never skip a test to get green.

## Running and reporting

- Run the specific file while iterating, then the whole suite before finishing.
- Show the command and the result summary (passed/failed counts). If something fails that you
  didn't touch, say so and show it was failing before your change (`git stash` to compare).
- Coverage numbers are a hint, not a goal; look at uncovered branches in the code you changed.

## Done when

New or changed behavior has tests for success, edge and failure cases; tests would fail if the code
broke; the suite passes; and you reported the command and results.
