#!/usr/bin/env node
/**
 * MCP server entry point. Invoked as `openslate mcp` (CLI subcommand) or
 * directly via `bun src/mcp/server.ts` during dev.
 */

import { startMcpServer } from "./server.js";

export { startMcpServer };
export * from "./types.js";

// Auto-start when invoked directly.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("/mcp/index.js")) {
  startMcpServer().catch((err) => {
    console.error("openSlate MCP server failed:", err);
    process.exit(1);
  });
}
