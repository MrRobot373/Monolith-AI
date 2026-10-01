import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  noExternal: [/^@aatmiq\//],
  clean: true,
  sourcemap: true,
});
