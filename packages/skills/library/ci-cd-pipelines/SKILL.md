---
name: ci-cd-pipelines
description: "Use when creating or fixing CI/CD pipelines (GitHub Actions, GitLab CI): lint/test/build jobs, caching, secrets, deploys, failing runs."
category: Software development
---

# CI/CD pipelines

## What every pipeline should do

On each pull request: install → lint/format check → type check → tests → build. On the main branch
(or tags): the same, then publish artifacts/images and deploy, with production gated by approval.

## GitHub Actions template

```yaml
name: CI
on:
  pull_request:
  push: { branches: [main] }
permissions: { contents: read }
concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    services:
      postgres:
        image: postgres:16
        env: { POSTGRES_PASSWORD: postgres }
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready" --health-interval 5s --health-retries 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm test
        env: { DATABASE_URL: postgres://postgres:postgres@localhost:5432/postgres }
      - run: npm run build
```

Python: `actions/setup-python@v5` with `cache: pip`, then `pip install -r requirements.txt`,
`ruff check .`, `pytest -q`.

## Good practice

- Pin actions to a major version (or a SHA for security-sensitive repos). Least-privilege
  `permissions`.
- Cache dependencies via the setup action's `cache` option; don't cache build output across branches.
- Matrices only for what you really support (`node-version: [20, 22]`).
- Fail fast on lint before running long tests; set `timeout-minutes`.
- Secrets via the platform's secret store (`${{ secrets.X }}`); never echo them; PRs from forks
  don't get secrets.
- Deploy jobs: `needs: test`, `if: github.ref == 'refs/heads/main'`, `environment: production`
  (with required reviewers), and a smoke test after deploying.

## GitLab CI equivalent

```yaml
stages: [test, build, deploy]
test:
  stage: test
  image: node:22
  cache: { key: { files: [package-lock.json] }, paths: [.npm/] }
  script: [npm ci --cache .npm, npm run lint, npm test]
deploy:
  stage: deploy
  script: ./scripts/deploy.sh
  environment: production
  rules: [{ if: '$CI_COMMIT_BRANCH == "main"', when: manual }]
```

## Diagnosing a failing run

1. Read the first error in the log (not the last line): the failing step and its output.
2. Reproduce locally with the same commands and versions as the workflow.
3. Classify: real test failure, environment difference (versions, missing service, env var),
   flaky test (passes on rerun — find the cause, don't just retry), or infrastructure.
4. Fix the cause in code or workflow; validate YAML syntax
   (`python3 -c "import yaml,sys; yaml.safe_load(open(sys.argv[1]))" .github/workflows/ci.yml`).

## Done when

The pipeline runs lint, types, tests and build on every change; secrets and permissions are minimal;
deploys are gated; and the YAML is valid and explained.
