#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# Flux AOT Upgrade + Restructure Script
# ============================================================================

echo "Starting Flux AOT upgrade..."

if ! command -v bun >/dev/null 2>&1; then
  echo "Error: bun is required."
  exit 1
fi

BACKUP_DIR=".flux-aot-backup-$(date +%Y%m%d-%H%M%S)"
echo "Backing up current project to ${BACKUP_DIR}"
mkdir -p "${BACKUP_DIR}"

if [[ -d src ]]; then
  cp -r src "${BACKUP_DIR}/src"
fi

if [[ -f builder.ts ]]; then
  cp builder.ts "${BACKUP_DIR}/builder.ts"
fi

if [[ -f package.json ]]; then
  cp package.json "${BACKUP_DIR}/package.json"
fi

if [[ -f tsconfig.json ]]; then
  cp tsconfig.json "${BACKUP_DIR}/tsconfig.json"
fi

mkdir -p src/shared
mkdir -p src/compiler/runtime
mkdir -p scripts/patches

# ============================================================================
# Shared ContextUsage
# ============================================================================

cat > src/shared/context-usage.ts <<'EOF'
/**
 * Shared context usage flags used by both compiler and runtime.
 *
 * This removes duplicated ContextUsage definitions between:
 * - src/compiler/types.ts
 * - src/core/types.ts
 */

export interface ContextUsage {
  body: boolean;
  params: boolean;
  query: boolean;
  file: boolean;
  headers: boolean;
  state: boolean;

  json: boolean;
  text: boolean;
  html: boolean;
  redirect: boolean;
  stream: boolean;
  empty: boolean;
  status: boolean;

  req: boolean;
  url: boolean;

  cookie: boolean;
  server: boolean;
  set: boolean;

  sendFile: boolean;
  proxy: boolean;
  forward: boolean;
  cache: boolean;
}

export const EMPTY_USAGE: ContextUsage = Object.freeze({
  body: false,
  params: false,
  query: false,
  file: false,
  headers: false,
  state: false,

  json: false,
  text: false,
  html: false,
  redirect: false,
  stream: false,
  empty: false,
  status: false,

  req: false,
  url: false,

  cookie: false,
  server: false,
  set: false,

  sendFile: false,
  proxy: false,
  forward: false,
  cache: false,
});

export const FULL_USAGE: ContextUsage = Object.freeze({
  body: true,
  params: true,
  query: true,
  file: true,
  headers: true,
  state: true,

  json: true,
  text: true,
  html: true,
  redirect: true,
  stream: true,
  empty: true,
  status: true,

  req: true,
  url: true,

  cookie: true,
  server: true,
  set: true,

  sendFile: true,
  proxy: true,
  forward: true,
  cache: true,
});
EOF

# ============================================================================
# New compiler types
# ============================================================================

cat > src/compiler/types.ts <<'EOF'
/**
 * Flux Compiler Type System
 *
 * AOT upgrade:
 * - unified ContextUsage from shared
 * - added advanced compiler options
 * - added route metadata for future validators/serializers/OpenAPI
 */

import type { ContextUsage } from "../shared/context-usage";
import { EMPTY_USAGE, FULL_USAGE } from "../shared/context-usage";

export type { ContextUsage };
export const EMPTY_CONTEXT_USAGE = EMPTY_USAGE;
export const FULL_CONTEXT_USAGE = FULL_USAGE;

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type RouterMode =
  | "auto"
  | "static-map"
  | "radix"
  | "bun-native";

export interface CompilerOptions {
  readonly routesDir: string;
  readonly outDir: string;
  readonly outFile: string;
  readonly target: "bun" | "node" | "deno";

  readonly optimizationLevel: 0 | 1 | 2 | 3;
  readonly inlineThreshold: number;
  readonly enableHandlerDeduplication: boolean;
  readonly sourceMap: boolean;
  readonly minify: boolean;

  readonly hooksDir?: string;

  readonly enableTracing?: boolean;
  readonly enableAccessLog?: boolean;
  readonly enableTraceHeaders?: boolean;
  readonly enableLifecycle?: boolean;
  readonly enableStrictMethods?: boolean;
  readonly enableFastBodyParsing?: boolean;

  readonly serviceName?: string;
  readonly requestIdHeader?: string;
  readonly exposeErrorDetails?: boolean;

  readonly maxJsonBytes?: number;
  readonly maxTextBytes?: number;
  readonly maxFormBytes?: number;
  readonly maxFileBytes?: number;

  readonly cluster?: number | "auto";
  readonly reusePort?: boolean;

  // Advanced AOT options
  readonly router?: RouterMode;
  readonly generateTypes?: boolean;
  readonly generateOpenAPI?: boolean;
  readonly generateClient?: boolean;

  readonly precompileValidators?: boolean;
  readonly precompileSerializers?: boolean;

  readonly hoistConstants?: boolean;
  readonly specializeContext?: boolean;
  readonly inlineHooks?: boolean;
  readonly treeshakeRuntime?: boolean;
  readonly routeCache?: boolean;

  readonly maxInlineBytes?: number;
}

export interface RouteCacheConfig {
  readonly maxAge?: number;
  readonly swr?: number;
  readonly immutable?: boolean;
  readonly vary?: readonly string[];
}

export const createDefaultOptions = (): CompilerOptions => ({
  routesDir: process.env.ROUTES_DIR || "./src/routes",
  outDir: process.env.OUT_DIR || "./dist",
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  inlineThreshold: 50,
  enableHandlerDeduplication: true,
  sourceMap: false,
  minify: false,

  enableTracing: true,
  enableAccessLog: true,
  enableTraceHeaders: true,
  enableLifecycle: true,
  enableStrictMethods: true,
  enableFastBodyParsing: false,

  serviceName: "flux",
  requestIdHeader: "x-request-id",
  exposeErrorDetails: process.env.NODE_ENV !== "production",

  router: "auto",
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  precompileValidators: false,
  precompileSerializers: false,

  hoistConstants: true,
  specializeContext: true,
  inlineHooks: true,
  treeshakeRuntime: true,
  routeCache: true,

  maxInlineBytes: 2048,
});

export const DEFAULT_OPTS: CompilerOptions = createDefaultOptions();

export interface Position {
  readonly line: number;
  readonly column: number;
}

export type SymbolKind =
  | "function"
  | "class"
  | "const"
  | "let"
  | "var"
  | "type"
  | "interface";

export interface SymbolInfo {
  readonly name: string;
  readonly kind: SymbolKind;
  readonly pos: Position;
  readonly isAsync: boolean;
  readonly isDefaultExport: boolean;
  readonly params: readonly string[];
  readonly returnType?: string;
  readonly decorators: readonly string[];
  readonly calls: readonly string[];
  readonly calledBy: readonly string[];
  readonly size: number;
  readonly hotness: number;
}

export interface ImportInfo {
  readonly source: string;
  readonly names: readonly string[];
  readonly defaultName?: string;
  readonly namespaceName?: string;
}

export interface ExportInfo {
  readonly name: string;
  readonly kind: "default" | "named" | "namespace";
  readonly symbolRef?: string;
}

export interface ModuleInfo {
  readonly path: string;
  readonly relPath: string;
  readonly content: string;
  readonly imports: readonly ImportInfo[];
  readonly exports: readonly ExportInfo[];
  readonly symbols: readonly SymbolInfo[];
  readonly hasDefaultExport: boolean;
  readonly schemaExport?: string;
  readonly configExport?: string;
  readonly callGraph: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dataFlow: ReadonlyMap<string, ReadonlySet<string>>;
}

export type ResponseType = "json" | "text" | "html" | "stream" | "unknown";

export interface RouteValidators {
  readonly body?: string;
  readonly query?: string;
  readonly params?: string;
  readonly headers?: string;
  readonly cookie?: string;
}

export interface RouteSerializers {
  readonly json?: string;
}

export interface RouteDef {
  readonly method: HttpMethod;
  readonly cache?: RouteCacheConfig;
  readonly path: string;
  readonly file: string;
  readonly moduleIdx: number;
  readonly handlerRef: string;
  readonly schemaRef: string | null;
  readonly paramNames: readonly string[];
  readonly isDynamic: boolean;
  readonly isStatic: boolean;
  readonly segmentCount: number;
  readonly signatureHash: number;
  readonly handlerSize: number;
  readonly isAsync: boolean;
  readonly shouldInline: boolean;
  readonly responseType: ResponseType;
  readonly hasValidation: boolean;
  readonly hotnessScore: number;
  readonly dedupGroup?: string;
  readonly hooks: readonly string[];
  readonly isConstantResponse: boolean;
  readonly constantResponse?: string;
  readonly usage: ContextUsage;

  // New optional AOT metadata
  readonly config?: Record<string, unknown>;
  readonly validators?: RouteValidators;
  readonly serializers?: RouteSerializers;
  readonly statusCodes?: readonly number[];
  readonly contentType?: string;
  readonly openapi?: Record<string, unknown>;
}

export interface HookDef {
  readonly name: string;
  readonly source: string;
  readonly moduleIdx: number;
  readonly isAsync: boolean;
}

export type { Logger } from "./logger";

export interface DiscoveryResult {
  readonly files: readonly string[];
  readonly modules: readonly ModuleInfo[];
}

export interface AnalysisResult {
  readonly routes: readonly RouteDef[];
  readonly modules: readonly ModuleInfo[];
  readonly hooks: ReadonlyMap<string, HookDef>;
}

export interface OptimizationMeta {
  readonly inlined: number;
  readonly deduplicated: number;
  readonly eliminated: number;
}

export interface OptimizationResult {
  readonly routes: readonly RouteDef[];
  readonly meta: OptimizationMeta;
}

export interface CompilationMeta {
  readonly inlinedHandlers: number;
  readonly deduplicatedHandlers: number;
  readonly eliminatedRoutes: number;
  readonly totalCompileTime: number;
}

export interface CompiledRoute {
  readonly staticRoutes: readonly RouteDef[];
  readonly dynamicRoutes: readonly RouteDef[];
  readonly modules: readonly ModuleInfo[];
  readonly meta: CompilationMeta;
}
EOF

# ============================================================================
# New compiler options validation
# ============================================================================

cat > src/compiler/validate.ts <<'EOF'
/**
 * Compiler options validation.
 *
 * Updated for AOT compiler options.
 */

import { Type, type Static } from "@sinclair/typebox";
import Ajv from "ajv";
import type { CompilerOptions } from "./types";
import { DEFAULT_OPTS } from "./types";
import type { Result } from "./fp";
import { ok, err } from "./fp";

const CompilerOptionsSchema = Type.Object(
  {
    routesDir: Type.String({ minLength: 1 }),
    outDir: Type.String({ minLength: 1 }),
    outFile: Type.String({ minLength: 1 }),

    target: Type.Union([
      Type.Literal("bun"),
      Type.Literal("node"),
      Type.Literal("deno"),
    ]),

    optimizationLevel: Type.Union([
      Type.Literal(0),
      Type.Literal(1),
      Type.Literal(2),
      Type.Literal(3),
    ]),

    inlineThreshold: Type.Number({ minimum: 0, maximum: 1000 }),
    enableHandlerDeduplication: Type.Boolean(),
    sourceMap: Type.Boolean(),
    minify: Type.Boolean(),

    hooksDir: Type.Optional(Type.String({ minLength: 1 })),

    enableTracing: Type.Optional(Type.Boolean()),
    enableAccessLog: Type.Optional(Type.Boolean()),
    enableTraceHeaders: Type.Optional(Type.Boolean()),
    enableLifecycle: Type.Optional(Type.Boolean()),
    enableStrictMethods: Type.Optional(Type.Boolean()),
    enableFastBodyParsing: Type.Optional(Type.Boolean()),

    serviceName: Type.Optional(Type.String({ minLength: 1 })),
    requestIdHeader: Type.Optional(Type.String({ minLength: 1 })),
    exposeErrorDetails: Type.Optional(Type.Boolean()),

    maxJsonBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxTextBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFormBytes: Type.Optional(Type.Integer({ minimum: 0 })),
    maxFileBytes: Type.Optional(Type.Integer({ minimum: 0 })),

    cluster: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Literal("auto")])
    ),

    reusePort: Type.Optional(Type.Boolean()),

    router: Type.Optional(
      Type.Union([
        Type.Literal("auto"),
        Type.Literal("static-map"),
        Type.Literal("radix"),
        Type.Literal("bun-native"),
      ])
    ),

    generateTypes: Type.Optional(Type.Boolean()),
    generateOpenAPI: Type.Optional(Type.Boolean()),
    generateClient: Type.Optional(Type.Boolean()),

    precompileValidators: Type.Optional(Type.Boolean()),
    precompileSerializers: Type.Optional(Type.Boolean()),

    hoistConstants: Type.Optional(Type.Boolean()),
    specializeContext: Type.Optional(Type.Boolean()),
    inlineHooks: Type.Optional(Type.Boolean()),
    treeshakeRuntime: Type.Optional(Type.Boolean()),
    routeCache: Type.Optional(Type.Boolean()),

    maxInlineBytes: Type.Optional(Type.Integer({ minimum: 0 })),
  },
  { additionalProperties: false }
);

export type ValidatedCompilerOptions = Static<typeof CompilerOptionsSchema>;

const ajv = new Ajv({
  allErrors: true,
  strict: false,
  useDefaults: true,
  coerceTypes: false,
});

const validate = ajv.compile(CompilerOptionsSchema);

export const validateOptions = (
  input: Partial<CompilerOptions>
): Result<CompilerOptions, string[]> => {
  const data = { ...DEFAULT_OPTS, ...input };

  if (validate(data)) {
    return ok(data as CompilerOptions);
  }

  const errors = (validate.errors ?? []).map((e) => {
    const path =
      e.instancePath?.replace(/^\//, "").replace(/\//g, ".") ||
      (e.params as any)?.missingProperty ||
      "options";

    return `${path}: ${e.message}`;
  });

  return err(errors);
};
EOF

# ============================================================================
# Artifacts phase: types, OpenAPI, client, manifest
# ============================================================================

cat > src/compiler/phases/artifacts.ts <<'EOF'
/**
 * AOT artifact generation:
 * - routes.d.ts
 * - openapi.json
 * - client.d.ts
 * - manifest.json
 */

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { RouteDef, CompilerOptions } from "../types";
import type { Logger } from "../logger";

const tsParamType = (paramNames: readonly string[]): string => {
  if (paramNames.length === 0) return "Record<string, never>";

  const lines = paramNames.map((name) => `    ${name}: string;`);
  return `{
${lines.join("\n")}
  }`;
};

export const generateRouteTypes = (routes: readonly RouteDef[]): string => {
  const lines: string[] = [];

  lines.push("// Auto-generated by Flux AOT compiler.");
  lines.push("// Do not edit manually.");
  lines.push("");
  lines.push("export interface FluxRoutes {");

  for (const route of routes) {
    const method = route.method.toLowerCase();

    lines.push(`  ${JSON.stringify(route.path)}: {`);
    lines.push(`    ${method}: {`);

    if (route.paramNames.length > 0) {
      lines.push(`      params: ${tsParamType(route.paramNames)};`);
    }

    if (route.usage.query) {
      lines.push("      query: Record<string, string | string[]>;");
    }

    if (route.usage.body) {
      lines.push("      body: unknown;");
    }

    lines.push("      response: unknown;");

    lines.push("    };");
    lines.push("  };");
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
};

export const generateClientDts = (): string => {
  return `// Auto-generated by Flux AOT compiler.
import type { FluxRoutes } from "./routes";

export type FluxClient = {
  [Path in keyof FluxRoutes]: {
    [Method in keyof FluxRoutes[Path]]: (
      ...args: FluxRoutes[Path][Method] extends { params: infer P }
        ? [params: P, init?: RequestInit]
        : [init?: RequestInit]
    ) => Promise<Response>;
  };
};

export declare function createClient(baseUrl?: string): FluxClient;
`;
};

const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");

export const generateOpenApi = (
  routes: readonly RouteDef[],
  opts: CompilerOptions
): Record<string, unknown> => {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const route of routes) {
    if (route.method === "ALL") continue;

    const openApiPath = toOpenApiPath(route.path);
    paths[openApiPath] ??= {};

    const operation: Record<string, unknown> = {
      operationId: `${route.method.toLowerCase()}_${openApiPath.replace(/[{}\/]/g, "_")}`,
      responses: {
        "200": {
          description: "Successful response",
        },
      },
    };

    const detail = (route.config as any)?.detail;
    if (detail && typeof detail === "object") {
      Object.assign(operation, detail);
    }

    if (route.paramNames.length > 0) {
      operation.parameters = route.paramNames.map((name) => ({
        name,
        in: "path",
        required: true,
        schema: { type: "string" },
      }));
    }

    if (route.usage.body) {
      operation.requestBody = {
        content: {
          "application/json": {
            schema: { type: "object" },
          },
        },
      };
    }

    paths[openApiPath][route.method.toLowerCase()] = operation;
  }

  return {
    openapi: "3.1.0",
    info: {
      title: opts.serviceName ?? "flux",
      version: "1.0.0",
    },
    paths,
  };
};

export const generateManifest = (
  routes: readonly RouteDef[],
  opts: CompilerOptions
): Record<string, unknown> => ({
  generatedAt: new Date().toISOString(),
  serviceName: opts.serviceName ?? "flux",
  target: opts.target,
  routes: routes.map((r) => ({
    method: r.method,
    path: r.path,
    file: r.file,
    isStatic: r.isStatic,
    isDynamic: r.isDynamic,
    isConstantResponse: r.isConstantResponse,
    responseType: r.responseType,
    paramNames: r.paramNames,
    hooks: r.hooks,
    usage: r.usage,
  })),
});

export const writeArtifacts = (
  routes: readonly RouteDef[],
  opts: CompilerOptions,
  logger: Logger
): void => {
  mkdirSync(opts.outDir, { recursive: true });

  if (opts.generateTypes) {
    const types = generateRouteTypes(routes);
    writeFileSync(join(opts.outDir, "routes.d.ts"), types);
    logger.info("Generated routes.d.ts");
  }

  if (opts.generateClient) {
    writeFileSync(join(opts.outDir, "client.d.ts"), generateClientDts());
    logger.info("Generated client.d.ts");
  }

  if (opts.generateOpenAPI) {
    const openapi = generateOpenApi(routes, opts);
    writeFileSync(
      join(opts.outDir, "openapi.json"),
      JSON.stringify(openapi, null, 2)
    );
    logger.info("Generated openapi.json");
  }

  const manifest = generateManifest(routes, opts);
  writeFileSync(join(opts.outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  logger.info("Generated manifest.json");
};
EOF

# ============================================================================
# New optimized codegen
# ============================================================================

cat > src/compiler/phases/codegen.ts <<'EOF'
/**
 * Flux AOT Code Generator
 *
 * Goals:
 * - prebake constant responses
 * - emit static route map
 * - emit sorted dynamic matcher
 * - specialize context per route
 * - tree-shake helpers
 * - avoid unnecessary runtime allocation
 */

import { dirname, join, relative } from "path";
import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  HookDef,
} from "../types";
import type { Logger } from "../logger";

interface CodegenConfig {
  target: "bun" | "node" | "deno";
  tracing: boolean;
  lifecycle: boolean;
  serviceName: string;
  exposeErrorDetails: boolean;
  specializeContext: boolean;
  reusePort: boolean;
}

interface RouteInfo {
  route: RouteDef;
  mod?: ModuleInfo;
  constantJson: string | null;
  hookNames: string[];
  hasHooks: boolean;
  needsFull: boolean;
  needsBody: boolean;
  minimalBody: boolean;
  minimalSendFile: boolean;
}

interface DynamicRouteInfo {
  method: string;
  regexLiteral: string;
  paramNames: string[];
  handlerName: string;
  segmentCount: number;
  hasWildcard: boolean;
  path: string;
}

const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  tracing: opts.enableTracing ?? false,
  lifecycle: opts.enableLifecycle ?? true,
  serviceName: opts.serviceName ?? "flux",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
});

const normalizeImportPath = (p: string): string => {
  let s = p.replace(/\\/g, "/").replace(/\.(ts|tsx|js|mjs|jsx)$/, "");
  if (!s.startsWith(".")) s = "./" + s;
  return s;
};

const handlerImportName = (route: RouteDef): string => `handler_${route.handlerRef}`;
const methodHandlerName = (route: RouteDef): string => `${route.method}_${route.handlerRef}`;
const finalizeName = (route: RouteDef): string => `finalize_${route.handlerRef}`;
const constantBodyVar = (route: RouteDef): string => `BODY_${route.handlerRef}`;
const constantInitVar = (route: RouteDef): string => `INIT_${route.handlerRef}`;

const hookIdent = (name: string): string =>
  `hook_${name.replace(/[^a-zA-Z0-9_$]/g, "_")}`;

const tryNormalizeConstant = (route: RouteDef): string | null => {
  if (!route.isConstantResponse || !route.constantResponse) return null;
  if (route.hooks.length > 0) return null;

  try {
    JSON.parse(route.constantResponse);
    return route.constantResponse;
  } catch {
    return null;
  }
};

const validHookNames = (
  route: RouteDef,
  hooks: ReadonlyMap<string, HookDef>
): string[] => route.hooks.filter((name) => hooks.has(name));

const routeReplyFn = (route: RouteDef): string => {
  if (route.responseType === "text") return "textReply";
  if (route.responseType === "html") return "htmlReply";
  if (route.responseType === "stream") return "streamReply";
  return "jsonReply";
};

const FORCE_FULL_TOKENS = [
  "ctx.cookie",
  "ctx.server",
  "ctx.set",
  "ctx.proxy",
  "ctx.forward",
  "ctx.cache",
];

const needsFullContext = (
  route: RouteDef,
  mod: ModuleInfo | undefined,
  cfg: CodegenConfig,
  hasHooks: boolean
): boolean => {
  if (!cfg.specializeContext) return true;
  if (hasHooks) return true;

  if (
    route.usage.cookie ||
    route.usage.set ||
    route.usage.proxy ||
    route.usage.forward ||
    route.usage.cache
  ) {
    return true;
  }

  if (mod && FORCE_FULL_TOKENS.some((token) => mod.content.includes(token))) {
    return true;
  }

  return false;
};

const generateFinalizer = (route: RouteDef): string => {
  const reply = routeReplyFn(route);

  return `function ${finalizeName(route)}(result) {
  if (result instanceof Response) return result;
  return ${reply}(result);
}`;
};

const generateMethodHandler = (info: RouteInfo, cfg: CodegenConfig): string => {
  const route = info.route;
  const name = methodHandlerName(route);

  if (info.constantJson !== null) {
    return `function ${name}(req, params, url, server) {
  return new Response(${constantBodyVar(route)}, ${constantInitVar(route)});
}`;
  }

  const pre: string[] = [];
  let callExpr = "";

  if (info.needsFull) {
    const ctxOpts: string[] = [];

    if (info.needsBody) {
      ctxOpts.push("body: BODY_LIMITS");
    }

    const ctxOptsExpr = ctxOpts.length > 0 ? `, { ${ctxOpts.join(", ")} }` : "";

    pre.push(`const ctx = createContext(req, params ?? EMPTY_PARAMS${ctxOptsExpr});`);

    if (route.usage.server) {
      pre.push("ctx.server = server;");
    }

    if (info.hasHooks) {
      pre.push(
        `const halted = await runHooks([${info.hookNames
          .map(hookIdent)
          .join(", ")}], ctx);`
      );
      pre.push("if (halted) return halted;");
    }

    callExpr = `${handlerImportName(route)}(ctx)`;
  } else {
    if (route.usage.query) {
      pre.push("const query = url.searchParams;");
    }

    if (info.minimalBody) {
      pre.push("const body = createLazyBody(req, BODY_LIMITS);");
    }

    if (route.usage.state) {
      pre.push("const state = new Map();");
    }

    const props: string[] = [];

    if (route.usage.params) {
      props.push("params: params ?? EMPTY_PARAMS");
    }

    if (info.minimalBody) {
      props.push("body");
    }

    if (route.usage.query) {
      props.push("query");
    }

    if (route.usage.headers) {
      props.push("headers: req.headers");
    }

    if (route.usage.req) {
      props.push("req");
    }

    if (route.usage.url) {
      props.push("url");
    }

    if (route.usage.server) {
      props.push("server");
    }

    if (route.usage.state) {
      props.push("state");
      props.push("getState: (key) => state.get(key)");
      props.push("setState: (key, value) => { state.set(key, value); }");
    }

    if (route.usage.json) {
      props.push("json: jsonReply");
    }

    if (route.usage.text) {
      props.push("text: textReply");
    }

    if (route.usage.html) {
      props.push("html: htmlReply");
    }

    if (route.usage.stream) {
      props.push("stream: streamReply");
    }

    if (route.usage.redirect) {
      props.push("redirect: redirectReply");
    }

    if (route.usage.empty) {
      props.push("empty: emptyReply");
    }

    if (route.usage.status) {
      props.push("status: (code) => new Response(null, { status: code })");
    }

    if (info.minimalSendFile) {
      props.push("sendFile: (path, opts) => coreSendFile(path, { req, ...opts })");
    }

    callExpr =
      props.length === 0
        ? `${handlerImportName(route)}({})`
        : `${handlerImportName(route)}({ ${props.join(", ")} })`;
  }

  const isAsync =
    route.isAsync ||
    info.hasHooks ||
    info.needsFull ||
    info.minimalBody ||
    route.usage.state;

  if (isAsync) {
    return `async function ${name}(req, params, url, server) {
  try {
    ${pre.join("\n    ")}
    const result = await ${callExpr};
    return ${finalizeName(route)}(result);
  } catch (err) {
    return errorResponse(err);
  }
}`;
  }

  return `function ${name}(req, params, url, server) {
  try {
    ${pre.join("\n    ")}
    const result = ${callExpr};
    if (result instanceof Response) return result;
    if (result && typeof result.then === "function") {
      return result
        .then((v) => ${finalizeName(route)}(v))
        .catch((err) => errorResponse(err));
    }
    return ${finalizeName(route)}(result);
  } catch (err) {
    return errorResponse(err);
  }
}`;
};

const escapeRegex = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const routePattern = (
  path: string
): { regexLiteral: string; paramNames: string[] } => {
  const paramNames: string[] = [];
  const segments = path.split("/").filter(Boolean);

  const pattern = segments
    .map((seg) => {
      if (seg.startsWith(":")) {
        paramNames.push(seg.slice(1));
        return "([^/]+)";
      }

      if (seg.startsWith("*")) {
        paramNames.push(seg.slice(1));
        return "(.*)";
      }

      return escapeRegex(seg);
    })
    .join("/");

  const source = segments.length === 0 ? "^/$" : `^/${pattern}$`;
  const regexLiteral = `/${source.replace(/\//g, "\\/")}/`;

  return { regexLiteral, paramNames };
};

export const generateServer = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions
): string => {
  const cfg = getConfig(opts);

  const BODY_LIMITS = JSON.stringify({
    maxJsonBytes: opts.maxJsonBytes ?? 2 * 1024 * 1024,
    maxTextBytes: opts.maxTextBytes ?? 2 * 1024 * 1024,
    maxFormBytes: opts.maxFormBytes ?? 2 * 1024 * 1024,
    maxFileBytes: opts.maxFileBytes ?? 20 * 1024 * 1024,
  });

  const fromDir = dirname(join(process.cwd(), opts.outDir, opts.outFile));

  const toImportPath = (absPath: string): string =>
    normalizeImportPath(relative(fromDir, absPath));

  const runtimeImport = (projectPath: string): string =>
    toImportPath(join(process.cwd(), projectPath));

  const routeInfos: RouteInfo[] = routes.map((route) => {
    const mod = modules[route.moduleIdx];
    const constantJson = tryNormalizeConstant(route);
    const hookNames = validHookNames(route, hooks);
    const hasHooks = cfg.lifecycle && hookNames.length > 0;
    const needsFull = needsFullContext(route, mod, cfg, hasHooks);
    const needsBody = route.usage.body || route.usage.file;
    const minimalBody = needsBody && !needsFull;
    const minimalSendFile = route.usage.sendFile && !needsFull;

    return {
      route,
      mod,
      constantJson,
      hookNames,
      hasHooks,
      needsFull,
      needsBody,
      minimalBody,
      minimalSendFile,
    };
  });

  const nonConstantInfos = routeInfos.filter((x) => x.constantJson === null);

  const anyNonConstant = nonConstantInfos.length > 0;
  const anyFullContext = nonConstantInfos.some((x) => x.needsFull);
  const anyLazyBody = nonConstantInfos.some((x) => x.minimalBody);
  const anySendFile = nonConstantInfos.some((x) => x.minimalSendFile);
  const anyHooks = cfg.lifecycle && nonConstantInfos.some((x) => x.hasHooks);

  const anyJson = anyNonConstant;
  const anyText = nonConstantInfos.some(
    (x) => x.route.usage.text || x.route.responseType === "text"
  );
  const anyHtml = nonConstantInfos.some(
    (x) => x.route.usage.html || x.route.responseType === "html"
  );
  const anyStream = nonConstantInfos.some(
    (x) => x.route.usage.stream || x.route.responseType === "stream"
  );
  const anyRedirect = nonConstantInfos.some((x) => x.route.usage.redirect);
  const anyEmpty = nonConstantInfos.some(
    (x) => x.route.usage.empty || x.route.usage.status
  );

  const handlerImports = Array.from(
    new Set(
      nonConstantInfos
        .map((info) => {
          if (!info.mod) return "";

          return `import { default as ${handlerImportName(
            info.route
          )} } from "${toImportPath(info.mod.path)}";`;
        })
        .filter(Boolean)
    )
  ).join("\n");

  const missingStubs = nonConstantInfos
    .filter((info) => !info.mod)
    .map((info) => {
      return `function ${handlerImportName(info.route)}() {
  throw new Error(${JSON.stringify(`Missing module for ${info.route.file}`)});
}`;
    })
    .join("\n");

  const hookImports = anyHooks
    ? Array.from(hooks.values())
        .map((h) => {
          const abs = join(process.cwd(), h.source);
          return `import { default as ${hookIdent(
            h.name
          )} } from "${toImportPath(abs)}";`;
        })
        .join("\n")
    : "";

  const coreImports: string[] = [];

  if (anyFullContext) {
    coreImports.push(
      `import { createContext } from "${runtimeImport("src/core/context.ts")}";`
    );
  }

  if (anyLazyBody) {
    coreImports.push(
      `import { createLazyBody } from "${runtimeImport("src/core/body.ts")}";`
    );
  }

  if (anySendFile) {
    coreImports.push(
      `import { sendFile as coreSendFile } from "${runtimeImport(
        "src/core/files.ts"
      )}";`
    );
  }

  const constants: string[] = [];

  constants.push(`const HDR_JSON = { "content-type": "application/json; charset=utf-8" };`);
  constants.push(`const JSON_INIT = { headers: HDR_JSON };`);
  constants.push(`const BODY_LIMITS = ${BODY_LIMITS};`);
  constants.push(`const EMPTY_PARAMS = Object.freeze({});`);
  constants.push(`const EXPOSE_ERRORS = ${cfg.exposeErrorDetails};`);
  constants.push(`const NOT_FOUND_BODY = '{"error":"Not Found"}';`);
  constants.push(`const NOT_FOUND_INIT = { status: 404, headers: HDR_JSON };`);
  constants.push(`const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
};`);

  for (const info of routeInfos) {
    if (info.constantJson === null) continue;

    constants.push(
      `const ${constantBodyVar(info.route)} = ${JSON.stringify(
        info.constantJson
      )};`
    );
    constants.push(
      `const ${constantInitVar(info.route)} = { status: 200, headers: HDR_JSON };`
    );
  }

  const helpers: string[] = [];

  helpers.push(`function notFound() {
  return new Response(NOT_FOUND_BODY, NOT_FOUND_INIT);
}`);

  helpers.push(`function errorResponse(err) {
  const status = err && typeof err.status === "number" ? err.status : 500;
  const message =
    EXPOSE_ERRORS && err instanceof Error
      ? err.message
      : STATUS_TEXT[status] || "Error";

  return Response.json({ error: message, status }, { status });
}`);

  if (anyJson) {
    helpers.push(`function jsonReply(data, init) {
  if (!init) return Response.json(data, JSON_INIT);

  const headers = new Headers(HDR_JSON);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return Response.json(data, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyText) {
    helpers.push(`const HDR_TEXT = { "content-type": "text/plain; charset=utf-8" };
const TEXT_INIT = { headers: HDR_TEXT };

function textReply(data, init) {
  const body = typeof data === "string" ? data : JSON.stringify(data);

  if (!init) return new Response(body, TEXT_INIT);

  const headers = new Headers(HDR_TEXT);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyHtml) {
    helpers.push(`const HDR_HTML = { "content-type": "text/html; charset=utf-8" };
const HTML_INIT = { headers: HDR_HTML };

function htmlReply(data, init) {
  const body = typeof data === "string" ? data : JSON.stringify(data);

  if (!init) return new Response(body, HTML_INIT);

  const headers = new Headers(HDR_HTML);

  if (init.headers) {
    new Headers(init.headers).forEach((value, key) => headers.set(key, value));
  }

  return new Response(body, {
    status: init.status ?? 200,
    headers,
  });
}`);
  }

  if (anyStream) {
    helpers.push(`function streamReply(stream, init) {
  return new Response(stream, init);
}`);
  }

  if (anyRedirect) {
    helpers.push(`function redirectReply(location, status = 302) {
  return Response.redirect(location, status);
}`);
  }

  if (anyEmpty) {
    helpers.push(`function emptyReply(status = 204) {
  return new Response(null, { status });
}`);
  }

  if (anyHooks) {
    helpers.push(`async function runHooks(hooks, ctx) {
  for (const hook of hooks) {
    const result = await hook(ctx);

    if (result instanceof Response) return result;

    if (
      result &&
      typeof result === "object" &&
      result.ok === false &&
      result.response instanceof Response
    ) {
      return result.response;
    }
  }

  return null;
}`);
  }

  const finalizers = nonConstantInfos
    .map((info) => generateFinalizer(info.route))
    .join("\n\n");

  const handlers = routeInfos
    .map((info) => generateMethodHandler(info, cfg))
    .join("\n\n");

  const staticEntries: string[] = [];
  const dynamicEntries: DynamicRouteInfo[] = [];

  for (const info of routeInfos) {
    const handlerName = methodHandlerName(info.route);

    if (info.route.isStatic) {
      staticEntries.push(
        `[${JSON.stringify(`${info.route.method}:${info.route.path}`)}, ${handlerName}]`
      );
      continue;
    }

    const pattern = routePattern(info.route.path);

    dynamicEntries.push({
      method: info.route.method,
      regexLiteral: pattern.regexLiteral,
      paramNames: pattern.paramNames,
      handlerName,
      segmentCount: info.route.segmentCount,
      hasWildcard: info.route.path.includes("*"),
      path: info.route.path,
    });
  }

  dynamicEntries.sort((a, b) => {
    if (a.hasWildcard !== b.hasWildcard) {
      return a.hasWildcard ? 1 : -1;
    }

    if (a.segmentCount !== b.segmentCount) {
      return b.segmentCount - a.segmentCount;
    }

    return a.path.localeCompare(b.path);
  });

  const staticRoutes = `const staticRoutes = new Map([
${staticEntries.join(",\n")}
]);`;

  const dynamicRoutes = `const dynamicRoutes = [
${dynamicEntries
  .map(
    (entry) => `  {
    method: ${JSON.stringify(entry.method)},
    pattern: ${entry.regexLiteral},
    paramNames: ${JSON.stringify(entry.paramNames)},
    handler: ${entry.handlerName},
  },`
  )
  .join("\n")}
];`;

  const router = `function decodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function routerFetch(req, server) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  let handler = staticRoutes.get(method + ":" + path);

  if (!handler) {
    handler = staticRoutes.get("ALL:" + path);
  }

  if (!handler && method === "HEAD") {
    handler = staticRoutes.get("GET:" + path);
  }

  if (handler) {
    return handler(req, EMPTY_PARAMS, url, server);
  }

  for (const route of dynamicRoutes) {
    if (route.method !== method && route.method !== "ALL") continue;

    const match = route.pattern.exec(path);
    if (!match) continue;

    const params = {};

    for (let i = 0; i < route.paramNames.length; i++) {
      params[route.paramNames[i]] = decodeParam(match[i + 1] ?? "");
    }

    return route.handler(req, params, url, server);
  }

  return notFound();
}`;

  const serverBootstrap =
    cfg.target === "bun"
      ? `if (import.meta.main) {
  const port = Number(process.env.PORT || 3000);

  Bun.serve({
    port,
    fetch: routerFetch,
    reusePort: ${cfg.reusePort},
  });

  console.log(${JSON.stringify(cfg.serviceName)} + " listening on :" + port);
}`
      : `// Node/Deno target: export fetch handler only.`;

  return [
    handlerImports,
    hookImports,
    coreImports.join("\n"),
    missingStubs,
    constants.join("\n"),
    helpers.join("\n\n"),
    finalizers,
    handlers,
    staticRoutes,
    dynamicRoutes,
    router,
    serverBootstrap,
    `export { routerFetch as fetch };`,
    `export default { fetch: routerFetch };`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

export const runCodeGen = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => generateServer(routes, modules, hooks, opts));
EOF

# ============================================================================
# New compiler orchestrator with artifacts
# ============================================================================

cat > src/compiler/index.ts <<'EOF'
/**
 * Flux Compiler Orchestrator
 *
 * AOT upgrade:
 * - validates options
 * - runs phases
 * - emits DX artifacts
 */

import type {
  CompilerOptions,
  CompiledRoute,
  DiscoveryResult,
  AnalysisResult,
  OptimizationResult,
} from "./types";

import type { Logger } from "./logger";
import { DEFAULT_OPTS } from "./types";
import { runDiscovery } from "./phases/discovery";
import { runAnalysis } from "./phases/analysis";
import { runOptimization } from "./phases/optimization";
import { runCodeGen } from "./phases/codegen";
import { runLinker } from "./phases/linker";
import { writeArtifacts } from "./phases/artifacts";
import { consoleLogger } from "./logger";
import { validateOptions } from "./validate";
import { defu } from "defu";

export { DEFAULT_OPTS };
export type { CompilerOptions, CompiledRoute };

export const mergeOptions = (
  opts: Partial<CompilerOptions>
): CompilerOptions => defu(opts, DEFAULT_OPTS) as CompilerOptions;

export const createCompilationResult = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  elapsedMs: number
): CompiledRoute => ({
  staticRoutes: optimized.routes.filter((r) => r.isStatic),
  dynamicRoutes: optimized.routes.filter((r) => r.isDynamic),
  modules: analysis.modules,
  meta: {
    inlinedHandlers: optimized.meta.inlined,
    deduplicatedHandlers: optimized.meta.deduplicated,
    eliminatedRoutes: optimized.meta.eliminated,
    totalCompileTime: elapsedMs,
  },
});

export const runDiscoveryPhase = (
  opts: CompilerOptions,
  logger: Logger
): DiscoveryResult =>
  logger.time("discovery", () => {
    const result = runDiscovery(opts, logger);

    logger.info("discovery complete", {
      files: result.files.length,
      modules: result.modules.length,
    });

    return result;
  });

export const runAnalysisPhase = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  logger: Logger
): AnalysisResult =>
  logger.time("analysis", () => {
    const result = runAnalysis(discovery, opts, logger);

    logger.info("analysis complete", {
      routes: result.routes.length,
      hooks: result.hooks.size,
    });

    return result;
  });

export const runOptimizationPhase = (
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): OptimizationResult =>
  logger.time("optimization", () => {
    const result = runOptimization(
      analysis.routes,
      analysis.modules,
      opts,
      logger
    );

    logger.info("optimization complete", {
      inlined: result.meta.inlined,
      deduplicated: result.meta.deduplicated,
      eliminated: result.meta.eliminated,
    });

    return result;
  });

export const runCodegenPhase = (
  optimized: OptimizationResult,
  analysis: AnalysisResult,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("codegen", () => {
    const code = runCodeGen(
      optimized.routes,
      analysis.modules,
      analysis.hooks,
      opts,
      logger
    );

    logger.info("codegen complete", {
      lines: code.split("\n").length,
    });

    return code;
  });

export const runLinkingPhase = (
  code: string,
  opts: CompilerOptions,
  logger: Logger
): string =>
  logger.time("linker", () => {
    return runLinker(code, opts, logger);
  });

export class FluxCompiler {
  constructor(private readonly input: Partial<CompilerOptions> = {}) {}

  compile(): CompiledRoute {
    const validated = validateOptions(this.input);

    if (!validated.ok) {
      throw new Error(
        `Compiler options invalid:\n${validated.error.join("\n")}`
      );
    }

    const opts = validated.value;
    const logger = consoleLogger();
    const t0 = performance.now();

    logger.info("flux compiler started", {
      target: opts.target,
      optimizationLevel: opts.optimizationLevel,
      routesDir: opts.routesDir,
      outDir: opts.outDir,
    });

    const discovery = runDiscoveryPhase(opts, logger);
    const analysis = runAnalysisPhase(discovery, opts, logger);
    const optimized = runOptimizationPhase(analysis, opts, logger);

    writeArtifacts(optimized.routes, opts, logger);

    const code = runCodegenPhase(optimized, analysis, opts, logger);
    const outPath = runLinkingPhase(code, opts, logger);

    const elapsed = performance.now() - t0;

    logger.info("build complete", {
      elapsedMs: Number(elapsed.toFixed(2)),
      outPath,
    });

    return createCompilationResult(optimized, analysis, elapsed);
  }
}

export function build(opts?: Partial<CompilerOptions>): CompiledRoute {
  return new FluxCompiler(opts).compile();
}

if (import.meta.main) {
  build();
}
EOF

# ============================================================================
# New builder defaults
# ============================================================================

cat > builder.ts <<'EOF'
import { build } from "./src/compiler/index";

build({
  routesDir: "./src/routes",
  outDir: "./dist",
  outFile: "__server.js",
  target: "bun",

  optimizationLevel: 3,
  minify: true,
  sourceMap: false,

  enableTracing: false,
  enableAccessLog: false,
  enableStrictMethods: false,

  router: "auto",
  generateTypes: true,
  generateOpenAPI: true,
  generateClient: true,

  specializeContext: true,
  hoistConstants: true,
  inlineHooks: true,
  treeshakeRuntime: true,
  routeCache: true,
});
EOF

# ============================================================================
# Safer core types using shared ContextUsage
# ============================================================================

cat > src/core/types.ts <<'EOF'
/**
 * Flux Core Unified Type System
 *
 * AOT upgrade:
 * - ContextUsage now comes from shared
 * - keeps runtime schema/lifecycle/server types
 */

import type { ContextUsage } from "../shared/context-usage";
import { EMPTY_USAGE, FULL_USAGE } from "../shared/context-usage";

export type { ContextUsage };
export { EMPTY_USAGE, FULL_USAGE };

export const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "ALL",
  "WS",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type MaybePromise<T> = T | Promise<T>;
export type MaybeArray<T> = T | T[];
export type MaybeReadonlyArray<T> = T | readonly T[];

export type Prettify<T> = { [K in keyof T]: T[K] } & {};
export type IsAny<T> = 0 extends 1 & T ? true : false;
export type IsNever<T> = [T] extends [never] ? true : false;

export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (
      value: unknown
    ) => MaybePromise<{ value: Output } | { issues: readonly SchemaIssue[] }>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export interface SchemaIssue {
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

export interface TSchema {
  [kind: string]: unknown;
  static?: unknown;
  type?: string;
  properties?: Record<string, TSchema>;
  items?: TSchema | TSchema[];
  anyOf?: TSchema[];
  oneOf?: TSchema[];
  allOf?: TSchema[];
  $ref?: string;
  $defs?: Record<string, TSchema>;
  default?: unknown;
  enum?: unknown[];
  format?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  required?: string[];
  additionalProperties?: boolean | TSchema;
  noValidate?: boolean;
  elysiaMeta?: string;
}

export type AnySchema = TSchema | StandardSchemaV1;

export type Static<T extends AnySchema> =
  T extends StandardSchemaV1<any, infer O>
    ? O
    : T extends TSchema
      ? T["static"]
      : unknown;

export interface RouteSchema {
  body?: unknown;
  headers?: unknown;
  query?: unknown;
  params?: unknown;
  cookie?: unknown;
  response?: unknown;
}

export interface InputSchema<Name extends string = string> {
  body?: AnySchema | Name;
  headers?: AnySchema | Name;
  query?: AnySchema | Name;
  params?: AnySchema | Name;
  cookie?: AnySchema | Name;
  response?: { [status: number]: AnySchema | Name };
}

export type LifeCycleType = "global" | "scoped" | "local";

export interface HookContainer<T = Function> {
  fn: T;
  scope?: LifeCycleType;
  subType?: string;
  checksum?: number;
  isAsync?: boolean;
  hasReturn?: boolean;
}

export interface LifeCycleStore {
  start: HookContainer[];
  request: HookContainer[];
  parse: HookContainer[];
  transform: HookContainer[];
  beforeHandle: HookContainer[];
  afterHandle: HookContainer[];
  mapResponse: HookContainer[];
  afterResponse: HookContainer[];
  trace: HookContainer[];
  error: HookContainer[];
  stop: HookContainer[];
}

export const EMPTY_LIFECYCLE: LifeCycleStore = {
  start: [],
  request: [],
  parse: [],
  transform: [],
  beforeHandle: [],
  afterHandle: [],
  mapResponse: [],
  afterResponse: [],
  trace: [],
  error: [],
  stop: [],
};

export interface SingletonBase {
  decorator: Record<string, unknown>;
  store: Record<string, unknown>;
  derive: Record<string, unknown>;
  resolve: Record<string, unknown>;
}

export interface DefinitionBase {
  type: Record<string, AnySchema>;
  error: Record<string, Error>;
}

export interface RouteConfig {
  cache?:
    | number
    | { maxAge?: number; swr?: number; immutable?: boolean; vary?: string[] };
  headers?: Record<string, string>;
  hooks?: string[];
  mount?: (req: Request) => MaybePromise<Response>;
}

export interface DocumentDecoration {
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Record<string, string[]>[];
  [key: string]: unknown;
}

export interface CookieOptions {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  priority?: "low" | "medium" | "high";
  partitioned?: boolean;
  sameSite?: true | false | "lax" | "strict" | "none";
  secure?: boolean;
  secrets?: string | null | (string | null)[];
}

export interface ElysiaCookie extends CookieOptions {
  value?: unknown;
}

export interface ServerOptions {
  port?: number | string;
  hostname?: string;
  reusePort?: boolean;
  development?: boolean;
  maxRequestBodySize?: number;
  idleTimeout?: number;
  routes?: Record<
    string,
    Function | Response | Record<string, Function | Response>
  >;
  websocket?: WebSocketHandler;
}

export interface WebSocketHandler<T = undefined> {
  open?(ws: ServerWebSocket<T>): MaybePromise<void>;
  message?(ws: ServerWebSocket<T>, message: string | Buffer): MaybePromise<void>;
  drain?(ws: ServerWebSocket<T>): MaybePromise<void>;
  close?(ws: ServerWebSocket<T>, code: number, reason: string): MaybePromise<void>;
  ping?(ws: ServerWebSocket<T>, data: Buffer): MaybePromise<void>;
  pong?(ws: ServerWebSocket<T>, data: Buffer): MaybePromise<void>;
  maxPayloadLength?: number;
  backpressureLimit?: number;
  closeOnBackpressureLimit?: boolean;
  idleTimeout?: number;
  sendPings?: boolean;
  perMessageDeflate?:
    | boolean
    | { compress?: boolean | string; decompress?: boolean | string };
}

export interface ServerWebSocket<T = undefined> {
  send(data: string | ArrayBuffer | Uint8Array, compress?: boolean): number;
  sendText(data: string, compress?: boolean): number;
  sendBinary(data: ArrayBuffer | Uint8Array, compress?: boolean): number;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(data?: string | ArrayBuffer): number;
  pong(data?: string | ArrayBuffer): number;
  publish(topic: string, data: string | ArrayBuffer, compress?: boolean): number;
  publishText(topic: string, data: string, compress?: boolean): number;
  publishBinary(topic: string, data: ArrayBuffer | Uint8Array, compress?: boolean): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  isSubscribed(topic: string): boolean;
  readonly subscriptions: string[];
  cork<T>(callback: (ws: ServerWebSocket<T>) => T): T;
  readonly remoteAddress: string;
  readonly readyState: 0 | 1 | 2 | 3;
  binaryType?: "nodebuffer" | "arraybuffer" | "uint8array";
  data: T;
}

export type { CompilerOptions } from "../compiler/types";
export { DEFAULT_OPTS } from "../compiler/types";
EOF

# ============================================================================
# Safer security plugin
# ============================================================================

cat > src/core/plugins/security.ts <<'EOF'
/**
 * Security Headers Plugin
 *
 * Fixed:
 * - no direct mutation of response headers
 */

import type { FluxPlugin } from "../plugin";

export interface SecurityOptions {
  contentSecurityPolicy?: string | false;
  crossOriginEmbedderPolicy?: string | false;
  crossOriginOpenerPolicy?: string | false;
  crossOriginResourcePolicy?: string | false;
  frameguard?: { action: "deny" | "sameorigin" } | false;
  hidePoweredBy?: boolean;
  hsts?: { maxAge?: number; includeSubDomains?: boolean; preload?: boolean } | false;
  noSniff?: boolean;
  referrerPolicy?: string | false;
  xssFilter?: boolean;
}

const DEFAULTS: SecurityOptions = {
  contentSecurityPolicy:
    "default-src 'self'; base-uri 'self'; font-src 'self' https: data:; form-action 'self'; frame-ancestors 'self'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self' https: 'unsafe-inline'",
  crossOriginEmbedderPolicy: "require-corp",
  crossOriginOpenerPolicy: "same-origin",
  crossOriginResourcePolicy: "same-origin",
  frameguard: { action: "deny" },
  hidePoweredBy: true,
  hsts: { maxAge: 15552000, includeSubDomains: true, preload: true },
  noSniff: true,
  referrerPolicy: "no-referrer",
  xssFilter: true,
};

export const security = (options: SecurityOptions = {}): FluxPlugin => {
  const opts = { ...DEFAULTS, ...options };

  return {
    name: "security",
    onResponse(_ctx, response) {
      const headers = new Headers(response.headers);

      if (opts.contentSecurityPolicy)
        headers.set("Content-Security-Policy", opts.contentSecurityPolicy);

      if (opts.crossOriginEmbedderPolicy)
        headers.set("Cross-Origin-Embedder-Policy", opts.crossOriginEmbedderPolicy);

      if (opts.crossOriginOpenerPolicy)
        headers.set("Cross-Origin-Opener-Policy", opts.crossOriginOpenerPolicy);

      if (opts.crossOriginResourcePolicy)
        headers.set("Cross-Origin-Resource-Policy", opts.crossOriginResourcePolicy);

      if (opts.frameguard)
        headers.set("X-Frame-Options", opts.frameguard.action.toUpperCase());

      if (opts.hidePoweredBy)
        headers.delete("X-Powered-By");

      if (opts.hsts) {
        let val = `max-age=${opts.hsts.maxAge ?? 15552000}`;
        if (opts.hsts.includeSubDomains) val += "; includeSubDomains";
        if (opts.hsts.preload) val += "; preload";
        headers.set("Strict-Transport-Security", val);
      }

      if (opts.noSniff)
        headers.set("X-Content-Type-Options", "nosniff");

      if (opts.referrerPolicy)
        headers.set("Referrer-Policy", opts.referrerPolicy);

      if (opts.xssFilter)
        headers.set("X-XSS-Protection", "0");

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
  };
};
EOF

# ============================================================================
# Safer macro plugin
# ============================================================================

cat > src/core/macro.ts <<'EOF'
/**
 * Macro System
 *
 * Fixed:
 * - afterHandle can return Response
 * - afterHandle hooks are placed in afterHandle lifecycle
 */

import type { FluxContext } from "./context";
import type { LifeCycleStore, HookContainer } from "./types";

export interface MacroContext {
  onRequest?: (ctx: FluxContext) => Response | void | Promise<Response | void>;
  beforeHandle?: (ctx: FluxContext) => Response | void | Promise<Response | void>;
  afterHandle?: (
    ctx: FluxContext,
    response: Response
  ) => Response | void | Promise<Response | void>;
  afterResponse?: (ctx: FluxContext, response: Response) => void | Promise<void>;
}

export type MacroFn = (value: unknown, ctx: MacroContext) => void;

export interface MacroDefinition {
  name: string;
  fn: MacroFn;
}

export const createMacroRegistry = () => {
  const macros = new Map<string, MacroFn>();

  return {
    register(name: string, fn: MacroFn) {
      macros.set(name, fn);
      return this;
    },

    apply(
      routeConfig: Record<string, unknown>,
      lifecycle: LifeCycleStore
    ): LifeCycleStore {
      const macroCtx: MacroContext = {};

      for (const [key, value] of Object.entries(routeConfig)) {
        const macro = macros.get(key);
        if (macro && value !== undefined) {
          macro(value, macroCtx);
        }
      }

      const requestHooks: HookContainer[] = [];
      const beforeHooks: HookContainer[] = [];
      const afterHooks: HookContainer[] = [];

      if (macroCtx.onRequest) {
        requestHooks.push({ fn: macroCtx.onRequest, scope: "local" });
      }

      if (macroCtx.beforeHandle) {
        beforeHooks.push({ fn: macroCtx.beforeHandle, scope: "local" });
      }

      if (macroCtx.afterHandle) {
        afterHooks.push({ fn: macroCtx.afterHandle, scope: "local" });
      }

      return {
        ...lifecycle,
        request: [...lifecycle.request, ...requestHooks],
        beforeHandle: [...lifecycle.beforeHandle, ...beforeHooks],
        afterHandle: [...lifecycle.afterHandle, ...afterHooks],
      };
    },

    has(name: string): boolean {
      return macros.has(name);
    },

    get size(): number {
      return macros.size;
    },
  };
};

export const authMacro: MacroDefinition = {
  name: "auth",
  fn(value, ctx) {
    if (value === true) {
      ctx.beforeHandle = (c: FluxContext) => {
        if (!c.headers.get("authorization")) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
      };
    }
  },
};

export const cacheMacro: MacroDefinition = {
  name: "cache",
  fn(value, ctx) {
    if (typeof value === "number") {
      ctx.afterHandle = (_c: FluxContext, response: Response) => {
        const headers = new Headers(response.headers);
        headers.set("cache-control", `public, max-age=${value}`);

        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      };
    }
  },
};
EOF

# ============================================================================
# Patch script for files we do not fully rewrite
# ============================================================================

cat > scripts/apply-flux-patches.mjs <<'PATCH_EOF'
import { readFileSync, writeFileSync, existsSync } from "node:fs";

function replaceInFile(file, search, replacement, options = {}){
  if (!existsSync(file)) {
    console.warn(`Skip missing file: ${file}`);
    return;
  }

  let content = readFileSync(file, "utf8");

  if (options.regex) {
    if (!search.test(content)) {
      console.warn(`Pattern not found in ${file}`);
      return;
    }

    content = content.replace(search, replacement);
  } else {
    if (!content.includes(search)) {
      console.warn(`Text not found in ${file}`);
      return;
    }

    content = content.replace(search, replacement);
  }

  writeFileSync(file, content);
  console.log(`Patched ${file}`);
}

// ---------------------------------------------------------------------------
// Patch AST usage detection
// ---------------------------------------------------------------------------

replaceInFile(
  "src/compiler/utils/ast.ts",
  /(import type \{[\s\S]*?\} from "\.\.\/types";)/,
  `$1
import { EMPTY_USAGE } from "../../shared/context-usage";`,
  { regex: true }
);

replaceInFile(
  "src/compiler/utils/ast.ts",
  /const CONTEXT_PROPS = new Set\(\[[\s\S]*?\]\);/,
  `const CONTEXT_PROPS = new Set([
  "body", "params", "query", "file", "files", "headers", "state", "req", "url",
  "cookie", "server", "set", "sendFile", "proxy", "forward", "cache",
]);`,
  { regex: true }
);

replaceInFile(
  "src/compiler/utils/ast.ts",
  /function detectUsage\(bodyNode: any, mapping: Map<string, string>\): ContextUsage \{[\s\S]*?\n\}\n/,
  `function detectUsage(bodyNode: any, mapping: Map<string, string>): ContextUsage {
  const usage: ContextUsage = { ...EMPTY_USAGE };

  walk(bodyNode, (n) => {
    if (n.type === "MemberExpression" && !n.computed && n.object?.type === "Identifier") {
      const root = mapping.get(n.object.name);

      if (root === "__root__") {
        const prop = n.property.name;

        if (prop === "body" || prop === "files") usage.body = true;
        if (prop === "file") usage.file = true;
        if (prop === "params") usage.params = true;
        if (prop === "query") usage.query = true;
        if (prop === "headers") usage.headers = true;
        if (prop === "state" || prop === "getState" || prop === "setState") usage.state = true;
        if (prop === "req") usage.req = true;
        if (prop === "url" || prop === "path" || prop === "method") usage.url = true;

        if (prop === "cookie") usage.cookie = true;
        if (prop === "server") usage.server = true;
        if (prop === "set") usage.set = true;

        if (prop === "json") usage.json = true;
        if (prop === "text") usage.text = true;
        if (prop === "html") usage.html = true;
        if (prop === "redirect") usage.redirect = true;
        if (prop === "stream") usage.stream = true;
        if (prop === "empty") usage.empty = true;
        if (prop === "status") usage.status = true;

        if (prop === "sendFile") usage.sendFile = true;
        if (prop === "proxy") usage.proxy = true;
        if (prop === "forward") usage.forward = true;
        if (prop === "cache") usage.cache = true;
      }
    }

    if (n.type === "Identifier" && mapping.has(n.name)) {
      const prop = mapping.get(n.name)!;

      if (prop === "body" || prop === "files") usage.body = true;
      if (prop === "file") usage.file = true;
      if (prop === "params") usage.params = true;
      if (prop === "query") usage.query = true;
      if (prop === "headers") usage.headers = true;
      if (prop === "state") usage.state = true;
      if (prop === "req") usage.req = true;
      if (prop === "url") usage.url = true;

      if (prop === "cookie") usage.cookie = true;
      if (prop === "server") usage.server = true;
      if (prop === "set") usage.set = true;

      if (prop === "sendFile") usage.sendFile = true;
      if (prop === "proxy") usage.proxy = true;
      if (prop === "forward") usage.forward = true;
      if (prop === "cache") usage.cache = true;
    }
  });

  return usage;
}
`,
  { regex: true }
);

// ---------------------------------------------------------------------------
// Patch analysis response inference + route config metadata
// ---------------------------------------------------------------------------

replaceInFile(
  "src/compiler/phases/analysis.ts",
  /const responseType = usage\.json[\s\S]*?: inferredResponseType;/,
  `const responseType = usage.json
    ? "json"
    : usage.text
      ? "text"
      : usage.html
        ? "html"
        : usage.stream
          ? "stream"
          : inferredResponseType;`,
  { regex: true }
);

replaceInFile(
  "src/compiler/phases/analysis.ts",
  `...(cache !== undefined ? { cache } : {}),`,
  `...(cache !== undefined ? { cache } : {}),
    ...(astParsed.config !== undefined ? { config: astParsed.config } : {}),`
);

// ---------------------------------------------------------------------------
// Patch body limits
// ---------------------------------------------------------------------------

replaceInFile(
  "src/core/body.ts",
  /body\.arrayBuffer = \(\) =>\s*use<ArrayBuffer>\([\s\S]*?limits\.maxTextBytes\s*\);/,
  `body.arrayBuffer = () =>
    use<ArrayBuffer>(
      "arrayBuffer",
      async () => {
        try {
          return await req.arrayBuffer();
        } catch {
          throw new BodyParseError("Invalid binary body", 400);
        }
      },
      limits.maxFileBytes
    );`,
  { regex: true }
);

replaceInFile(
  "src/core/body.ts",
  /body\.blob = \(\) =>\s*use<Blob>\([\s\S]*?limits\.maxTextBytes\s*\);/,
  `body.blob = () =>
    use<Blob>(
      "blob",
      async () => {
        try {
          return await req.blob();
        } catch {
          throw new BodyParseError("Invalid blob body", 400);
        }
      },
      limits.maxFileBytes
    );`,
  { regex: true }
);

// ---------------------------------------------------------------------------
// Patch async hook detection
// ---------------------------------------------------------------------------

replaceInFile(
  "src/core/hooks.ts",
  /const ASYNC_RE = \/async\|await\|\\\.then\\\(\|Promise\/;[\s\S]*?ASYNC_RE\.test\(fn\.toString\(\)\.slice\(0, 200\)\);/,
  `export const isAsyncFn = (fn: Function): boolean =>
  fn.constructor.name === "AsyncFunction" ||
  fn.constructor.name === "AsyncGeneratorFunction";`,
  { regex: true }
);

console.log("Patch application complete.");
PATCH_EOF

# ============================================================================
# Apply patches
# ============================================================================

echo "Applying embedded patches..."
bun scripts/apply-flux-patches.mjs

echo ""
echo "Flux AOT upgrade complete."
echo "Backup saved to ${BACKUP_DIR}"
echo ""
echo "Next steps:"
echo "  1. bun run typecheck"
echo "  2. bun run build"
echo "  3. bun run dist/__server.js"