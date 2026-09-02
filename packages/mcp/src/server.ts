/**
 * Ignex MCP server — registers the agent-facing tools on an `McpServer`.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  runDebugClientsTool,
  runDebugDiagnosticsTool,
  runDebugEventPublishTool,
  runDebugEventsTool,
  runDebugHistoryTool,
  runDebugKtTool,
  runDebugLogsTool,
  runDebugMetricsTool,
  runDebugNovaEventsTool,
  runDebugReplayTool,
  runDebugRequestsTool,
  runDebugRequestTool,
  runDebugStateTool,
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
      title: "Debugbar: event buffer (NATS + realtime)",
      description:
        "List recent events from the unified debugbar event buffer: NATS pub/sub AND nova realtime/WS traffic (published/sent + received), each row tagged with source, in/out direction, kind, event/subject, target, size and truncated payload. Filter by subject/event name. For the raw nova transport trace use debug-nova-events.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        limit: z.number().optional().describe("Max rows (1-500, default 50)"),
        subject: z.string().optional().describe("Filter by NATS subject or nova event name"),
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
    "debug-nova-events",
    {
      title: "Debugbar: nova (FlatBuffer realtime) event trace",
      description:
        "See what fired in the app's nova FlatBuffer transport — every emitted, published, and received realtime event (client / remote instance / NATS bridge), newest first, with per-event counts and frame sizes. Use to debug realtime/websocket flows.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        limit: z.number().optional().describe("Max rows (1-500, default 50)"),
        name: z.string().optional().describe('Filter by wire event name (e.g. "quote.tick")'),
        direction: z
          .string()
          .optional()
          .describe(
            'Filter by direction: "out.publish" | "out.emit" | "in.client" | "in.remote" | "in.bridge"',
          ),
        clear: z.boolean().optional().describe("Clear the retained trace rows instead of listing"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugNovaEventsTool(
            args as unknown as Parameters<typeof runDebugNovaEventsTool>[0],
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
        "The app's knowledge-transfer page (markdown): project map (where routes/models/middleware live), the repo's documentation inventory, route map with per-route usage, plugins, lifecycle stages, observed DB activity per route (normalized statements + counts + routes), span kinds and environment — lets an agent understand the app before touching it.",
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

  // ── observatory tools ────────────────────────────────────────────────────
  //
  // Structured logs, metrics (Prometheus-compatible), leak diagnostics,
  // process state and SQLite-persisted history — the deep-inspection layer
  // behind the debugbar's observatory.

  register(
    "debug-logs",
    {
      title: "Observatory: structured logs",
      description:
        "Read the app's structured log stream with filters: minimum level (debug/info/warn/error), text search, correlated trace id. persisted=true reads the SQLite history that survives restarts instead of the live ring.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        limit: z.number().optional().describe("Max rows (1-500, default 100)"),
        level: z
          .enum(["debug", "info", "warn", "error"])
          .optional()
          .describe("Minimum level (inclusive)"),
        q: z.string().optional().describe("Substring filter over message"),
        traceId: z.string().optional().describe("Only logs emitted inside this request trace"),
        persisted: z.boolean().optional().describe("Read from SQLite history instead of live ring"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugLogsTool(args as unknown as Parameters<typeof runDebugLogsTool>[0]),
        },
      ],
    }),
  );

  register(
    "debug-metrics",
    {
      title: "Observatory: metrics + Prometheus export",
      description:
        "Per-route request counts, error counts and duration quantiles (p50/p95/p99), system gauges and custom counters. format='prometheus' returns the exact Prometheus exposition a Grafana scrape would pull.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        format: z
          .enum(["json", "prometheus"])
          .optional()
          .describe("Response format (default json)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugMetricsTool(
            args as unknown as Parameters<typeof runDebugMetricsTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-diagnostics",
    {
      title: "Observatory: leak & trend diagnostics",
      description:
        "Detect memory leaks and degradation BEFORE production incidents: heap/RSS growth slopes with fit quality, event-loop saturation, in-flight requests never draining. Each finding carries measured evidence + recommendation. gc=true forces a full GC first and reports freed memory.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        gc: z
          .boolean()
          .optional()
          .describe("Force full GC and report freed memory instead of analyzing"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugDiagnosticsTool(
            args as unknown as Parameters<typeof runDebugDiagnosticsTool>[0],
          ),
        },
      ],
    }),
  );

  register(
    "debug-state",
    {
      title: "Observatory: application state",
      description:
        "Snapshot of application + process state: runtime versions, memory breakdown, environment variable NAMES (never values), route/plugin inventory, store sizes and feature flags.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugStateTool(args as unknown as Parameters<typeof runDebugStateTool>[0]),
        },
      ],
    }),
  );

  register(
    "debug-history",
    {
      title: "Observatory: persisted trace history",
      description:
        "Query the SQLite observatory db (.ignex/observatory.db) for request traces across restarts — the post-mortem record. Filter by time range, method, status family, errors-only, minimum duration or text; pass id for one fully reconstructed trace with spans.",
      inputSchema: {
        url: z.string().optional().describe("Debugbar base URL (default: $IGNEX_DEBUGBAR_URL)"),
        token: z.string().optional().describe("Debugbar token (default: $IGNEX_DEBUGBAR_TOKEN)"),
        id: z
          .string()
          .optional()
          .describe("Fetch one persisted trace by id (full detail incl. spans)"),
        limit: z.number().optional().describe("Max rows (1-200, default 50)"),
        q: z.string().optional().describe("Substring over method+path+error"),
        method: z.string().optional().describe("HTTP method, e.g. GET"),
        status: z.string().optional().describe("Status family 2xx/3xx/4xx/5xx or exact code"),
        error: z.boolean().optional().describe("Only failed requests"),
        minMs: z.number().optional().describe("Minimum duration ms"),
        since: z.number().optional().describe("Epoch ms lower bound"),
        until: z.number().optional().describe("Epoch ms upper bound"),
      },
    },
    async (args) => ({
      content: [
        {
          type: "text",
          text: await runDebugHistoryTool(
            args as unknown as Parameters<typeof runDebugHistoryTool>[0],
          ),
        },
      ],
    }),
  );

  return server;
};
