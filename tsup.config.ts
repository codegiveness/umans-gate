import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "esnext",
  platform: "neutral",
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  // Don't bundle bun:sqlite — it's a built-in Bun module
  noExternal: [],
  // Keep native modules external
  external: ["bun:sqlite"],
});
