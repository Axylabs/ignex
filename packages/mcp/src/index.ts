/**
 * @ignex/mcp — Model Context Protocol server for Ignex.
 *
 * Exposes agent-facing tools (`build`, `route`, `info`, `doctor`, `openapi`,
 * `dev`) so agents can scaffold, compile, and inspect ignex projects without
 * hand-running CLI commands. The server speaks stdio (the standard transport
 * used by Claude/Copilot/Codex-style MCP clients).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server.js";

export { createMcpServer, MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./server.js";
export * from "./tools.js";

/**
 * Connect an McpServer over stdio. Used by the `ignex mcp` CLI command and the
 * `ignex-mcp` bin.
 */
export const startMcpServer = async (server: McpServer = createMcpServer()): Promise<void> => {
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

if (import.meta.main) {
  await startMcpServer();
}
