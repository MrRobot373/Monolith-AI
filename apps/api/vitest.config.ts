import { defineConfig } from "vitest/config";

// API test files share one test database, so they run one after another.
export default defineConfig({ test: { fileParallelism: false } });
