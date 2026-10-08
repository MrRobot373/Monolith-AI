#!/usr/bin/env bash
# The team load test (team.mjs) on the stack run-work.sh starts, with the fake model paced like a
# GPU: 400 ms to the first word, then 40 words a second. Results go to tests/load/results.
#   USERS=25 MINUTES=5 CODE_USERS=5 tests/load/run-team.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export FAKE_LLM_FIRST_MS="${FAKE_LLM_FIRST_MS:-400}" FAKE_LLM_WORD_MS="${FAKE_LLM_WORD_MS:-25}"
E2E_SCRIPT="$ROOT/tests/load/team.mjs" LOG_DIR="$ROOT/tests/load/results" exec "$ROOT/tests/e2e/run-work.sh"
