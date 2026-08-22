/**
 * @ignex/mcp tests — protocol-level (initialize/tools/list/call over an
 * in-memory transport) plus unit checks of the tool implementations.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createMcpServer } from "../src/server.js";
import { runBuildTool, runInfoTool, runRouteTool } from "../src/tools.js";

const mcpTempDirs: string[] = [];
afterEach(() => {
  for (const d of mcpTempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

const track = (dir: string): string => {
  mcpTempDirs.push(dir);
  return dir;
};

const connect = async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "1.0.0" }, { capabilities: {} });
  // Server first: `client.connect` awaits the initialize handshake, which the
  // in-memory transport can only answer once the server is connected.
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client };
};

const textOf = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<string> => {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return content[0]?.text ?? "";
};

describe("ignex MCP server (protocol)", () => {
  it("lists the expected tools", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "build",
      "debug-clients",
      "debug-event-publish",
      "debug-events",
      "debug-kt",
      "debug-replay",
      "debug-request",
      "debug-requests",
      "debug-summary",
      "debug-system",
      "dev",
      "devStop",
      "doctor",
      "info",
      "list-routes",
      "openapi",
      "route",
    ]);
    await client.close();
  });

  it("serves doctor over the protocol", async () => {
    const { client } = await connect();
    const text = await textOf(client, "doctor", {});
    const parsed = JSON.parse(text) as { ok: boolean; checks: unknown[] };
    expect(Array.isArray(parsed.checks)).toBe(true);
    await client.close();
  });

  it("serves info over the protocol", async () => {
    const { client } = await connect();
    const parsed = JSON.parse(await textOf(client, "info", {})) as { cwd: string; native: boolean };
    expect(typeof parsed.cwd).toBe("string");
    expect(typeof parsed.native).toBe("boolean");
    await client.close();
  });
});

describe("ignex MCP tools (unit)", () => {
  it("route tool scaffolds a route file", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "ignex-mcp-route-")));
    const parsed = JSON.parse(await runRouteTool({ root: dir, input: "health.get" })) as {
      ok: boolean;
      path: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("/health");
    expect(existsSync(join(dir, "src/routes/health.get.ts"))).toBe(true);
  });

  it("info tool reports the runtime", async () => {
    const parsed = JSON.parse(await runInfoTool({})) as { runtime: string };
    // The vitest node environment may not expose the Bun global; accept either.
    expect(["bun", "node"]).toContain(parsed.runtime);
  });

  it("build tool degrades gracefully on a bare project", async () => {
    const dir = track(mkdtempSync(join(tmpdir(), "ignex-mcp-build-")));
    const parsed = JSON.parse(await runBuildTool({ root: dir })) as { ok?: boolean };
    // A bare dir compiles to an empty server (ok) or reports a structured
    // error — it must never throw into the protocol.
    expect("ok" in parsed).toBe(true);
  });
});
