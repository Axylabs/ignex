/**
 * `ignex mcp` — run the Ignex Model Context Protocol server over stdio.
 *
 * Launches the @ignex/mcp server so MCP clients (Claude, Copilot, Codex, …)
 * can drive the compiler/CLI as agent tools. Blocks while connected.
 */
import { startMcpServer } from "@ignex/mcp";

export const runMcp = async (): Promise<void> => {
  await startMcpServer();
};
