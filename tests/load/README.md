# Load test

`team.mjs` puts a team's busiest minutes on a running Aatmiq: `USERS` people (default 25) for
`MINUTES` (5), each chatting, starting agent tasks or opening pages every 5–15 seconds, and
`CODE_USERS` (5) with the Code editor open in a real browser. It reports time to the first word of
chat answers, how long agent tasks wait for a slot, page API times, errors, and memory per agent
task and per editor. The model is the fake one, paced like a GPU (`FAKE_LLM_FIRST_MS`, 400 ms;
`FAKE_LLM_WORD_MS`, 25 ms), so it measures Aatmiq, not the model server.

```bash
USERS=25 MINUTES=5 CODE_USERS=5 tests/load/run-team.sh     # needs what run-work.sh needs, plus the IDE build
```

Results: `tests/load/results/team-<users>.md` and `.json`. For the model server itself, use vLLM's
benchmark (docs/10-team-server.md#capacity).
