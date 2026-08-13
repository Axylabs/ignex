#!/usr/bin/env bun
/**
 * `ignex-mcp` binary — run the Ignex MCP server over stdio.
 *
 * Usually invoked through `ignex mcp`; this bin exists so the server can also
 * be launched directly (e.g. pointing an MCP client at the package).
 */
import { startMcpServer } from "../src/index.js";

try {
  await startMcpServer();
} catch (err) {
  console.error("Failed to start ignex MCP server:", err);
  process.exit(1);
}
