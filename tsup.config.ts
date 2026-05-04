import { cp } from "node:fs/promises";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    cli: "src/cli/index.ts",
    "mcp/index": "src/mcp/index.ts",
    "compositor/index": "src/compositor/index.ts",
    "compositor/remotion-entry": "src/compositor/remotion-entry.tsx",
  },
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
  target: "node20",
  external: ["react", "react-dom", "remotion", "@remotion/bundler", "@remotion/renderer", "playwright-core"],
  // Cursor sprite SVGs ship as static files (resolved at render time via
  // Remotion's publicDir + staticFile). They aren't in the TS import graph,
  // so tsup wouldn't copy them otherwise.
  async onSuccess() {
    await cp("src/compositor/cursor-sprites", "dist/compositor/cursor-sprites", {
      recursive: true,
    });
  },
});
