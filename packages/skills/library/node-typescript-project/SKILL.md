---
name: node-typescript-project
description: "Use when writing Node.js/TypeScript CLIs, servers or scripts: package.json/tsconfig setup, ESM, async patterns, errors, tests."
category: Software development
---

# Node.js and TypeScript project

## Read the setup first

`package.json` (type: module?, scripts, engines, package manager from the lockfile: npm, pnpm, yarn),
`tsconfig.json` (target, module, strict), lint/format configs. Use the existing package manager and
scripts; don't add a second one.

## New project baseline

```bash
npm init -y && npm pkg set type=module
npm i -D typescript @types/node tsx vitest
npx tsc --init --target es2022 --module nodenext --moduleResolution nodenext --strict --outDir dist --rootDir src
```

Scripts: `"dev": "tsx watch src/index.ts"`, `"build": "tsc"`, `"start": "node dist/index.js"`,
`"test": "vitest run"`, `"typecheck": "tsc --noEmit"`.

## Code style

- `strict` TypeScript; no `any` (use `unknown` + narrowing). Validate external data (env, HTTP
  bodies, files) with a schema library such as zod at the boundary.
- ESM imports with explicit extensions in NodeNext projects (`./util.js`). Use `node:` prefixes
  for built-ins (`import { readFile } from "node:fs/promises"`).
- `async/await` everywhere; never leave a promise floating — `await` it, `return` it, or
  `void` it deliberately with a `.catch`.
- Run independent work concurrently: `await Promise.all([...])`, with a concurrency limit for big
  lists.
- Errors: throw `Error` subclasses with useful messages; catch at boundaries; add context when
  rethrowing (`new Error("Loading config failed", { cause: e })`).
- Config from `process.env`, validated once at startup.
- Graceful shutdown: handle `SIGTERM`/`SIGINT`, close servers and DB pools.

## Patterns

```ts
import { z } from "zod";

const Env = z.object({ PORT: z.coerce.number().default(3000), DATABASE_URL: z.string().url() });
export const env = Env.parse(process.env);

export async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= tries) throw e;
      await new Promise((r) => setTimeout(r, 2 ** i * 200));
    }
  }
}
```

## Quality checks

`npx tsc --noEmit`, the linter (`npm run lint`), tests (`npm test`), and run the program once with
a real input. Check `npm ls <pkg>` when unsure which version is installed, and follow that version's
API.

## Done when

It type-checks under strict mode, tests cover the logic, errors carry context, and you documented
the commands to run it.
