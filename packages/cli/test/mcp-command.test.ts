/**
 * `ignex mcp` — the MCP server is an OPTIONAL peer, so the command must fail
 * with actionable install instructions instead of a bare resolution error when
 * the peer is absent.
 */

import { describe, expect, it, vi } from "vitest";

// Simulates a consumer that installed @ignex/cli without the optional peer.
vi.mock("@ignex/mcp", () => {
  throw new Error("Cannot find module '@ignex/mcp'");
});

describe("runMcp without the optional peer installed", () => {
  it("explains how to install @ignex/mcp", async () => {
    const { runMcp } = await import("../src/commands/mcp.js");

    await expect(runMcp([])).rejects.toThrow(/bun add -d @ignex\/mcp/);
  });
});
