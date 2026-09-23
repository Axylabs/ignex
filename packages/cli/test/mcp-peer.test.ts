/**
 * Guards the `ignex mcp` wiring: `@ignex/mcp` is declared as an OPTIONAL peer
 * of `@ignex/cli` (it drags in the ~90-package Model Context Protocol SDK),
 * and the command loads it dynamically rather than at module scope.
 *
 * If the peer declaration or the workspace link is dropped, `ignex mcp` breaks
 * silently — this asserts the peer still resolves and exposes the entry point
 * the command calls.
 */

import { describe, expect, it } from "vitest";

describe("@ignex/mcp peer contract", () => {
  it("resolves the optional peer and exposes startMcpServer", async () => {
    const mod = await import("@ignex/mcp");

    expect(typeof mod.startMcpServer).toBe("function");
  });
});
