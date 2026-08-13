/**
 * Ignex MCP server — registers the agent-facing tools on an `McpServer`.
 */

import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type {
  BuildToolArgs,
  DevToolArgs,
  InfoToolArgs,
  OpenApiToolArgs,
  RouteToolArgs,
} from "./tools.js";
import {
  runBuildTool,
  runDevTool,
  runDoctorTool,
  runInfoTool,
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
      description: "Spawn `ignex dev` for the project in the background and report the process.",
      inputSchema: {
        root: z.string().optional().describe("Project root (default: cwd)"),
        port: z.number().optional().describe("PORT env for the spawned server"),
      },
    },
    async (args) => ({
      content: [{ type: "text", text: runDevTool(args as unknown as DevToolArgs) }],
    }),
  );

  return server;
};
