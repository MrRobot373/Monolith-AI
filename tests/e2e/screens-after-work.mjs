// Runs work.mjs (it creates the owner, tasks, skills and connectors), then screens.mjs.
// Usage: E2E_SCRIPT=tests/e2e/screens-after-work.mjs tests/e2e/run-work.sh
import { spawnSync } from "node:child_process";

const dir = new URL(".", import.meta.url).pathname;
spawnSync("node", [`${dir}work.mjs`], { stdio: "inherit" });
const r = spawnSync("node", [`${dir}screens.mjs`], { stdio: "inherit" });
process.exit(r.status ?? 1);
