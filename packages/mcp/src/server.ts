/**
 * Ignex MCP server — registers the agent-facing tools on an `McpServer`.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  runDebugClientsTool,
  runDebugEventPublishTool,
  runDebugEventsTool,
  runDebugKtTool,
  runDebugReplayTool,
  runDebugRequestsTool,
  runDebugRequestTool,
  runDebugSummaryTool,
  runDebugSystemTool,
} from "./debugger.js";
import type {
  BuildToolArgs,
  DevToolArgs,
  InfoToolArgs,
  OpenApiToolArgs,
  RouteToolArgs,
} from "./tools.js";
import {
  runBuildTool,
  runDevStopTool,
  runDevTool,
  runDoctorTool,
  runInfoTool,
  runListRoutesTool,
  runOpenApiTool,
  runRouteTool,
} from "./tools.js";

/** The MCP server name advertised in the protocol handshake. */
export const MCP_SERVER_NAME = "ignex";

// Single source of truth: read the version from package.json so the advertised
// protocol version can never drift from the published package.
const MCP_PKG_VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: string;
  }
).version;

/** The MCP server version advertised in the protocol handshake. */
export const MCP_SERVER_VERSION = MCP_PKG_VERSION ?? "0.0.0";

type TextContent = { type: "text"; text: string };
type ToolResult = { content: TextContent[] };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Loose registrar — sidesteps tsc-7's "excessively deep" generic instantiation
 * on the SDK's `registerTool` with multi-field zod shapes. The SDK's actual
 * runtime registration still parses/validates args through the zod schema.
 */
type RegisterFn = (
  name: string,
  config: { title?: string; description?: string; inputSchema?: unknown },
  cb: ToolHandler,
) => void;

/** Build an McpServer with all Ignex tools registered. */
export const createMcpServer = (): McpServer => {
  const server = new McpServer({
    name: MCP_SERVER_NAME,
    version: MCP_SERVER_VERSION,
  });
  const register = (server.registerTool as unknown as RegisterFn).bind(server);

  register(
    "build",
    {
      title: "Build an Ignex project",
      description:
        "AOT-compile an ignex project (discovery → analysis → codegen → link → artifacts). Returns cached status, out file, warnings, errors, and optimization metadata.",
      inputSchema: {
        root: z.string().optional().describe("Project root (default: cwd)"),
        outDir: z.string().optional().describe("Compiler output directory (default: .ignex)"),
        routesDir: z.string().optional().describe("Route source directory (default: src/routes)"),
        minify: z.boolean().optional().describe("Enable minification (default: false)"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await runBuildTool(args as unknown as BuildToolArgs) }],
    }),
  );

  register(
    "route",
    {
      title: "Scaffold a route file",
      description:
        "Create a route file using the file-system routing convention (e.g. 'products/[id].get' → GET /products/:id).",
      inputSchema: {
        root: z.string().optional().describe("Project root (default: cwd)"),
        input: z.string().describe("Route input, e.g. 'products/[id].get' or 'upload.post'"),
        method: z
          .enum(["get", "post", "put", "patch", "del", "all"])
          .optional()
          .describe("HTTP method when not encoded in the input"),
        schema: z.boolean().optional().describe("Add TypeBox schema boilerplate"),
        named: z.boolean().optional().describe("Use a named-export handler"),
        force: z.boolean().optional().describe("Overwrite an existing route file"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await runRouteTool(args as unknown as RouteToolArgs) }],
    }),
  );

  register(
    "info",
    {
      title: "Show project info",
      description:
        "Environment + config snapshot for the project root (runtime, versions, native status, config paths).",
      inputSchema: { root: z.string().optional().describe("Project root (default: cwd)") },
    },
    async (args) => ({
      content: [{ type: "text", text: await runInfoTool(args as unknown as InfoToolArgs) }],
    }),
  );

  register(
    "list-routes",
    {
      title: "List route files",
      description:
        "Enumerate the project's route files under src/routes (no build required) — path, method, and structure for the agent.",
      inputSchema: { root: z.string().optional().describe("Project root (default: cwd)") },
    },
    async (args) => ({
      content: [{ type: "text", text: await runListRoutesTool(args as unknown as InfoToolArgs) }],
    }),
  );

  register(
    "doctor",
    {
      title: "Check the environment",
      description:
        "Health-check the runtime, native acceleration availability, and compiler wiring.",
      inputSchema: {},
    },
    async () => ({ content: [{ type: "text", text: await runDoctorTool() }] }),
  );

  register(
    "openapi",
    {
      title: "Generate OpenAPI document",
      description: "Build the project and return the generated openapi.json.",
      inputSchema: { root: z.string().optional().describe("Project root (default: cwd)") },
    },
    async (args) => ({
      content: [{ type: "text", text: await runOpenApiTool(args as unknown as OpenApiToolArgs) }],
    }),
  );

  register(
    "dev",
    {
      title: "Start the dev server",
      description:
        "Spawn `ignex dev` for the project in the background and report the process. Pass --port as a CLI flag via the `port` arg (default 3000).",
      inputSchema: {
        root: z.string().optional().describe("Project root (default: cwd)"),
        port: z.number().optional().describe("Listen port passed via --port (default 3000)"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: await runDevTool(args as unknown as DevToolArgs) }],
    }),
  );

  register(
    "devStop",
    {
      title: "Stop a dev server",
      description:
        "Stop a dev server previously started with the `dev` tool (by the pid it returned).",
      inputSchema: {
        pid: z.number().describe("The pid returned by the `dev` tool"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: runDevStopTool({ pid: (args as { pid: number }).pid }) }],
    }),
  );

  // ── debugger tools (connect an AI agent to a running app's debugbar) ──
  //
  // Every tool talks to the debugbar REST API of a RUNNING app. The base URL
  // comes from IGNEX_DEBUGBAR_URL (e.g. http://localhost:3000/__debugbar) and
  // IGNEX_DEBUGBAR_TOKEN for a token-gated debugbar; both can be overridden
  // per call. The `debug-summary` tool is the token-efficient entry point: one
  // compact JSON document with errors, slow traces, event stats and published
  // clients — the agent reads it first, then drills in.

  register(
    "debug-summary",
    {
      title: "Debugbar: compact issue summary",
      description:
        "Fetch one compact JSON snapshot from the app's debugbar: error/slow request traces, NATS event-queue stats, published clients and route count. Start here for any debugging session.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugSummaryTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-requests",
    {
      title: "Debugbar: list request traces",
      description:
        "List recent request traces from the debugbar with server-side filters (error-only, text search, method, status family) and a result limit. Compact rows — use debug-request for full detail.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        limit: z.number().optional().describe("Max rows (1-200, default 50)"),
        error: z.boolean().optional().describe("Only failed requests"),
        q: z.string().optional().describe("Substring over method+path+error"),
        method: z.string().optional().describe("HTTP method, e.g. GET"),
        status: z.string().optional().describe("Status family: 2xx/3xx/4xx/5xx"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugRequestsTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-request",
    {
      title: "Debugbar: full request detail",
      description:
        "Fetch one request trace by id with everything: the span tree, waterfall timings, queries, redacted headers, error stack and body — for root-cause analysis.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        id: z.string().describe("The trace id (from debug-summary or debug-requests)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugRequestTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-replay",
    {
      title: "Debugbar: replay a request",
      description:
        "Re-issue a stored request through the live server (full pipeline: routing, hooks, handler) and return the fresh status, duration, request id and body.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        id: z.string().describe("The trace id to replay"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugReplayTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-events",
    {
      title: "Debugbar: NATS event queue",
      description:
        "List recent NATS events tracked by the debugbar (published + received) with per-subject stats. Filter by subject. Payloads are truncated.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        limit: z.number().optional().describe("Max rows (1-200, default 50)"),
        subject: z.string().optional().describe("Filter by subject prefix"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugEventsTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-event-publish",
    {
      title: "Debugbar: publish a NATS event",
      description:
        "Publish a probe event through the app's NATS connection and record it in the events panel — useful to test consumers and event-driven flows.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        subject: z.string().describe("NATS subject, e.g. orders.created"),
        payload: z.unknown().optional().describe("JSON payload to publish (default {})"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugEventPublishTool(
            args as unknown as Parameters<typeof runDebugEventPublishTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-system",
    {
      title: "Debugbar: system profile",
      description:
        "CPU / RSS / heap / event-loop-delay samples with request totals (avg, p95) — for performance investigations.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugSystemTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-clients",
    {
      title: "Debugbar: published clients",
      description:
        "List the published SDK + FlatBuffers frontend clients detected by the debugbar with local versions and git tags (the release signal) — verify what frontend teams are running.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugClientsTool(
            args as unknown as Parameters<typeof runDebugRequestTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-kt",
    {
      title: "Debugbar: how this app works",
      description:
        "The app's knowledge-transfer page (markdown): route map, plugins, lifecycle stages, span kinds, environment — lets an agent understand the app before touching it.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugKtTool(args as unknown as Parameters<typeof runDebugRequestTool>[0]),
        },
      ],
    }),
  );

  return server;
};
