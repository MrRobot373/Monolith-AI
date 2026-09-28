# Browser end-to-end suite

80 checks that drive the real app in Chromium: setup, chat, models, workspaces, invites,
roles, quotas and token requests, workspace admins, user management, settings, audit,
usage, sign-in flows and mobile layout.

Run against a **fresh** install (empty database) with `ALLOW_MOCK_PROVIDER=true`:

```bash
cd tests/e2e && npm install
node fake-llm.mjs &                     # fake Ollama/OpenAI-compatible server on :11500
CHROMIUM_PATH=/path/to/chrome node full.mjs   # BASE_URL defaults to http://localhost:3000
```

Each step reports PASS/FAIL; failures save a screenshot to `results/`.
