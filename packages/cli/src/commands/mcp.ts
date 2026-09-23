/**
 * `ignex mcp` — run the Ignex Model Context Protocol server over stdio.
 *
 * Launches the @ignex/mcp server so MCP clients (Claude, Copilot, Codex, …)
 * can drive the compiler/CLI as agent tools. Blocks while connected.
 */

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

/**
 * Load the MCP server, which is an OPTIONAL peer of this package.
 *
 * `@ignex/mcp` pulls in the Model Context Protocol SDK (~90 packages) that no
 * other CLI command needs — so it is declared as an optional peer and imported
 * only when this command actually runs. That keeps `ignex build/dev/route/…`
 * and `create-ignex` installs free of the SDK.
 *
 * @returns The server's stdio entry point.
 * @throws Error with install instructions when the peer is absent.
 */
const loadMcpServer = async (): Promise<() => Promise<void>> => {
  try {
    const mod = await import("@ignex/mcp");
    return mod.startMcpServer;
  } catch (error) {
    throw new Error(
      "The `ignex mcp` command needs the optional peer @ignex/mcp, which ships " +
        "the Model Context Protocol SDK the rest of the CLI does not use.\n" +
        "  Install it:      bun add -d @ignex/mcp\n" +
        "  Or run directly: bunx @ignex/mcp",
      { cause: error },
    );
  }
};

/** Run `ignex mcp` — block on the stdio MCP server. */
export const runMcp = async (args: string[]): Promise<void> => {
  void args;
  const startMcpServer = await loadMcpServer();
  await startMcpServer();
};
