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
