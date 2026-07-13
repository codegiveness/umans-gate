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
  noExternal: [],
  external: ["bun:sqlite", "bun"],
});
