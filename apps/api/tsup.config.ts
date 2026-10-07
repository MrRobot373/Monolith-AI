import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts", "src/worker.ts", "src/copy-files-to-s3.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  // Bundle workspace packages (they ship TypeScript source); keep npm deps external.
  noExternal: [/^@aatmiq\//],
  clean: true,
  sourcemap: true,
});
