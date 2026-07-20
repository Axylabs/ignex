/**
 * @fileoverview Flux Compiler Type System
 * All types are immutable interfaces (readonly) where possible.
 * No implementation here — pure contracts.
 */

// ---------------------------------------------------------------------------
// HTTP & Routing
// ---------------------------------------------------------------------------
export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "ALL"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];


export interface ContextUsage {
  body: boolean;
  params: boolean;
  query: boolean;
  file: boolean;
  headers: boolean;
  state: boolean;
  json: boolean;
  text: boolean;
  redirect: boolean;
  req: boolean;
  url: boolean;
}

export const FULL_CONTEXT_USAGE: ContextUsage = {
  body: true,
  params: true,
  query: true,
  file: true,
  headers: true,
  state: true,
  json: true,
  text: true,
  redirect: true,
  req: true,
  url: true,
};


// ---------------------------------------------------------------------------
// Compiler Configuration
// ---------------------------------------------------------------------------
export interface CompilerOptions {
  readonly routesDir: string;
  readonly outDir: string;
  readonly outFile: string;
  readonly target: "bun" | "node" | "deno";
  readonly optimizationLevel: 0 | 1 | 2 | 3;
  readonly inlineThreshold: number;
  readonly enableSchemaInlining: boolean;
  readonly enableResponsePreserialization: boolean;
  readonly enableWorkerThreads: boolean;
  readonly sourceMap: boolean;
  readonly minify: boolean;
  readonly enableSIMDPaths: boolean;
  readonly enableBranchPrediction: boolean;
  readonly enableDeadCodeElimination: boolean;
  readonly enableConstantFolding: boolean;
  readonly enableHandlerDeduplication: boolean;
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

  readonly browserCache?: {
    readonly maxAge?: number;
    readonly swr?: number;
    readonly immutable?: boolean;
    readonly vary?: readonly string[];
  };

  readonly cacheBust?: "mtime" | "hash" | "none";
}

export interface RouteCacheConfig {
  readonly maxAge?: number;
  readonly swr?: number;
  readonly immutable?: boolean;
  readonly vary?: readonly string[];
}

export const DEFAULT_OPTS: CompilerOptions = {
  routesDir: process.env.ROUTES_DIR || "./src/routes",
  outDir: process.env.OUT_DIR || "./dist",
  outFile: "__server.js",
  target: "bun",
  optimizationLevel: 3,
  inlineThreshold: 50,
  enableSchemaInlining: true,
  enableResponsePreserialization: true,
  enableWorkerThreads: false,
  sourceMap: false,
  minify: false,
  enableSIMDPaths: true,
  enableBranchPrediction: true,
  enableDeadCodeElimination: true,
  enableConstantFolding: true,
  enableHandlerDeduplication: true,
  enableTracing: true,
  enableAccessLog: true,
  enableTraceHeaders: true,
  enableLifecycle: true,
  enableStrictMethods: true,
  enableFastBodyParsing: false,
  serviceName: "flux",
  requestIdHeader: "x-request-id",
  exposeErrorDetails: process.env.NODE_ENV !== "production",
};

// ---------------------------------------------------------------------------
// Source Positions & Symbols
// ---------------------------------------------------------------------------
export interface Position {
  readonly line: number;
  readonly column: number;
}

export type SymbolKind = "function" | "class" | "const" | "let" | "var" | "type" | "interface";

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

// ---------------------------------------------------------------------------
// Module Metadata
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Route Definitions
// ---------------------------------------------------------------------------
export type ResponseType = "json" | "text" | "html" | "stream" | "unknown";

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
  readonly usage: ContextUsage;  // ← NEW: build-time context usage
}

export interface HookDef {
  readonly name: string;
  readonly source: string;
  readonly moduleIdx: number;
  readonly isAsync: boolean;
}

// ---------------------------------------------------------------------------
// Trie & Jump Table
// ---------------------------------------------------------------------------
export interface Terminal {
  readonly method: HttpMethod;
  readonly handlerRef: string;
  readonly schemaRef: string | null;
  readonly paramNames: readonly string[];
  readonly routeIdx: number;
}

export interface SegNode {
  readonly terminals: ReadonlyMap<HttpMethod, Terminal>;
  readonly staticChildren: ReadonlyMap<string, SegNode>;
  readonly paramChild: { readonly name: string; readonly child: SegNode } | null;
  readonly catchAll: ReadonlyMap<HttpMethod, { readonly name: string; readonly handlerRef: string; readonly schemaRef: string | null }>;
  readonly depth: number;
  readonly segmentHash?: number;
}

export type JumpStrategy = "dense" | "sparse" | "perfect-hash";

export interface JumpTable {
  readonly strategy: JumpStrategy;
  readonly entries: ReadonlyArray<{ readonly hash: number; readonly routeIdx: number } | null>;
  readonly minHash: number;
  readonly maxHash: number;
  readonly collisions: ReadonlyMap<number, readonly number[]>;
  readonly lookupCode: string;
  readonly seed?: number;

}
export type { Logger } from "./logger";
// ---------------------------------------------------------------------------
// Compilation Results
// ---------------------------------------------------------------------------
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
  readonly trie: SegNode;
  readonly jumpTable: JumpTable;
  readonly preserializedBuffers: ReadonlyMap<string, string>;
  readonly meta: OptimizationMeta;
}

export interface CompilationMeta {
  readonly inlinedHandlers: number;
  readonly deduplicatedHandlers: number;
  readonly eliminatedRoutes: number;
  readonly preserializedResponses: number;
  readonly totalCompileTime: number;
}

export interface CompiledRoute {
  readonly staticRoutes: readonly RouteDef[];
  readonly dynamicRoutes: readonly RouteDef[];
  readonly trie: SegNode;
  readonly modules: readonly ModuleInfo[];
  readonly jumpTable: JumpTable;
  readonly meta: CompilationMeta;
}