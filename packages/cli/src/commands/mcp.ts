/**
 * `ignus mcp` — run the Ignus Model Context Protocol server over stdio.
 *
 * Launches the @ignus/mcp server so MCP clients (Claude, Copilot, Codex, …)
 * can drive the compiler/CLI as agent tools. Blocks while connected.
 */
import { startMcpServer } from "@ignus/mcp";

export const runMcp = async (): Promise<void> => {
  await startMcpServer();
};
