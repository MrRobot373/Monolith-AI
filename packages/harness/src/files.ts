/**
 * Files shipped with this package (the DSH plugin, the DSH CLI). Resolved through the package
 * itself so it works from source, from tests, and when the API is bundled into one file.
 */
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
let root: string | null = null;

export function harnessRoot(): string {
  root ??= dirname(require.resolve("@aatmiq/harness/package.json"));
  return root;
}

export function harnessFile(rel: string): string {
  return join(harnessRoot(), rel);
}

/** Resolve a dependency of this package (pnpm keeps them next to it, not next to the app). */
export function resolveFromHarness(id: string): string {
  return createRequire(join(harnessRoot(), "package.json")).resolve(id);
}
