/**
 * `ignex mcp` — run the Ignex Model Context Protocol server over stdio.
 *
 * Launches the @ignex/mcp server so MCP clients (Claude, Copilot, Codex, …)
 * can drive the compiler/CLI as agent tools. Blocks while connected.
 */

import { startMcpServer } from "@ignex/mcp";
import { defineCommand } from "citty";
import { metaFor } from "./registry.js";

/** Typed CLI surface shared by parsing and usage rendering. */
const argsDef = {};

export const mcpCmd = defineCommand({
  meta: metaFor("mcp"),
  args: argsDef,
  async run(ctx) {
    await runMcp(ctx.rawArgs);
  },
});

export default mcpCmd;

/** Run `ignex mcp` — block on the stdio MCP server. */
export const runMcp = async (args: string[]): Promise<void> => {
  void args;
  await startMcpServer();
};
