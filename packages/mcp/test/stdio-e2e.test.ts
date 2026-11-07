/**
 * @fileoverview Process-level MCP e2e — spawns the real stdio server entry
 * (`packages/mcp/src/index.ts`, the module the `ignex mcp` CLI command loads
 * and the `ignex-mcp` bin runs), then speaks raw JSON-RPC 2.0 over the child's
 * stdin/stdout with newline-delimited framing: `initialize` handshake,
 * `notifications/initialized`, `tools/list`, and one read-only `tools/call`
 * (`doctor` — health-checks the runtime, no app and no network needed).
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, describe, expect, it } from "vitest";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "../src/server.js";

/** The spawnable stdio entry: same `startMcpServer()` the `ignex mcp` command runs. */
const MCP_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

/** Newline-delimited JSON-RPC message (the MCP stdio wire format). */
type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown> | undefined;
  error?: { code: number; message: string; data?: unknown };
};

/** Generous per-step budget — the child cold-starts Bun + the MCP SDK. */
const STEP_TIMEOUT_MS = 10_000;

const ENTRY_EXISTS = existsSync(MCP_ENTRY);

/** A minimal MCP client speaking newline-delimited JSON-RPC over a child stdio. */
interface StdioClient {
  request(id: number, method: string, params?: Record<string, unknown>): Promise<JsonRpcMessage>;
  notify(method: string, params?: Record<string, unknown>): void;
  stderr: string;
  kill(): Promise<void>;
}

const createStdioClient = (entry: string): StdioClient => {
  const child = spawn("bun", [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  }) as ChildProcessWithoutNullStreams;

  let buffer = "";
  const received: JsonRpcMessage[] = [];
  const waiters: Array<{
    matches: (msg: JsonRpcMessage) => boolean;
    resolve: (msg: JsonRpcMessage) => void;
    fail: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  const dispatch = (msg: JsonRpcMessage): void => {
    const i = waiters.findIndex((w) => w.matches(msg));
    if (i >= 0) {
      const w = waiters.splice(i, 1)[0];
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    received.push(msg);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try {
          dispatch(JSON.parse(line) as JsonRpcMessage);
        } catch {
          // Non-protocol line on stdout — ignore (the server never emits one).
        }
      }
      newline = buffer.indexOf("\n");
    }
  });

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const waitFor = (
    matches: (msg: JsonRpcMessage) => boolean,
    label: string,
  ): Promise<JsonRpcMessage> => {
    const queued = received.findIndex(matches);
    if (queued >= 0) return Promise.resolve(received.splice(queued, 1)[0]);
    return new Promise<JsonRpcMessage>((resolve, reject) => {
      const w = {
        matches,
        resolve,
        fail: reject,
        timer: undefined as unknown as ReturnType<typeof setTimeout>,
      };
      w.timer = setTimeout(() => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(
          new Error(
            `timeout (${STEP_TIMEOUT_MS}ms) waiting for ${label}` +
              (stderr ? ` — stderr: ${stderr.trim().slice(-400)}` : ""),
          ),
        );
      }, STEP_TIMEOUT_MS);
      waiters.push(w);
    });
  };

  const send = (msg: JsonRpcMessage): void => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
  };

  return {
    request(id, method, params = {}) {
      send({ jsonrpc: "2.0", id, method, params });
      return waitFor(
        (msg) => msg.id === id && (msg.result !== undefined || msg.error !== undefined),
        method,
      );
    },
    notify(method, params = {}) {
      send({ jsonrpc: "2.0", method, params });
    },
    get stderr(): string {
      return stderr;
    },
    async kill(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => {
        const done = (): void => resolve();
        child.once("exit", done);
        child.kill("SIGTERM");
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 2_000);
      });
    },
  };
};

/** One client per run — the three tests share a single stdio session in order. */
let client: StdioClient | undefined;

afterAll(async () => {
  if (client) await client.kill();
});

describe.skipIf(!ENTRY_EXISTS)("ignex MCP server over real stdio (process e2e)", () => {
  it("completes the initialize handshake over the child's stdin/stdout", async () => {
    expect(ENTRY_EXISTS).toBe(true);
    client = createStdioClient(MCP_ENTRY);
    // The SDK's own client advertises LATEST_PROTOCOL_VERSION (= first entry).
    const response = await client.request(1, "initialize", {
      protocolVersion: SUPPORTED_PROTOCOL_VERSIONS[0],
      capabilities: {},
      clientInfo: { name: "ignex-stdio-e2e", version: "0.0.0" },
    });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      protocolVersion: string;
      serverInfo: { name: string; version: string };
      capabilities: Record<string, unknown>;
    };
    expect(SUPPORTED_PROTOCOL_VERSIONS).toContain(result.protocolVersion);
    expect(result.serverInfo.name).toBe(MCP_SERVER_NAME);
    expect(result.serverInfo.version).toBe(MCP_SERVER_VERSION);
    expect(typeof result.capabilities).toBe("object");
    client.notify("notifications/initialized");
  });

  it("lists its tools over stdio", async () => {
    if (!client) throw new Error("initialize handshake failed — no stdio session");
    const response = await client.request(2, "tools/list");
    expect(response.error).toBeUndefined();
    const tools = response.result?.tools as Array<{ name: string; description?: string }>;
    expect(Array.isArray(tools)).toBe(true);
    const names = tools.map((t) => t.name);
    expect(names).toContain("doctor");
    expect(names).toContain("build");
    expect(names).toContain("list-routes");
    for (const tool of tools) {
      expect(typeof tool.name).toBe("string");
    }
  });

  it("serves the read-only doctor tool over stdio", async () => {
    if (!client) throw new Error("initialize handshake failed — no stdio session");
    const response = await client.request(3, "tools/call", { name: "doctor", arguments: {} });
    expect(response.error).toBeUndefined();
    const result = response.result as {
      isError?: boolean;
      content: Array<{ type: string; text?: string }>;
    };
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.type).toBe("text");
    const parsed = JSON.parse(result.content[0]?.text ?? "") as {
      ok: boolean;
      checks: Array<{ name: string; ok: boolean; detail: string }>;
    };
    expect(Array.isArray(parsed.checks)).toBe(true);
    const names = parsed.checks.map((c) => c.name);
    expect(names).toContain("runtime");
    expect(names).toContain("compiler");
    for (const check of parsed.checks) {
      expect(typeof check.ok).toBe("boolean");
      expect(typeof check.detail).toBe("string");
    }
  });
});
