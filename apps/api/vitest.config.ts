import { defineConfig } from "vitest/config";

// API test files share one test database, so they run one after another. Their setup and teardown
// start and stop real servers (agent runtimes, Chromium), which can take a while on a CI machine.
export default defineConfig({ test: { fileParallelism: false, hookTimeout: 60_000 } });
