#!/usr/bin/env bun
/**
 * `ignus-mcp` binary — run the Ignus MCP server over stdio.
 *
 * Usually invoked through `ignus mcp`; this bin exists so the server can also
 * be launched directly (e.g. pointing an MCP client at the package).
 */
import { startMcpServer } from "../src/index.js";

await startMcpServer();
