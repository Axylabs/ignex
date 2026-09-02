/**
 * @fileoverview Codegen: shared mutable state threaded through the emission
 * stages. Each stage appends to its own section so the final assembly order
 * (imports → header → helpers → cache decls → functions) is deterministic.
 *
 * Dead-code elimination of generated runtime helpers is delegated to the
 * linker's bundler (`Bun.build` treeshaking) — no string-key usage tracking
 * lives here. Only `@ignex/core` symbols that the ENTRY itself references by
 * identifier are collected (`usedCore`): emitted identifiers must be imported,
 * which is inherent information, not duplication.
 */

import type { CodegenConfig } from "./config";

/**
 * The table-bound wrapper variant recorded for a route during pass 1 and
 * consumed by the route-table pass. `wildcard` (the default for anything
 * unrecorded, e.g. WS routes) keeps the generic runtime-checked `__wrap`.
 */
export type WrapVariant = "static" | "static-sync" | "wildcard";

export interface CodegenState {
  cfg: CodegenConfig;

  // Emitted sections (assembled in this order at the end).
  imports: Set<string>;
  header: string[];
  cacheDecls: string[];
  functions: string[];

  /**
   * `@ignex/core` symbols referenced by EMITTED route/header identifiers in
   * the entry (sendFile, runHooks, createContext, …). Generated runtime
   * helpers declare their own core deps inside their sources — the bundler
   * prunes unused exports — so only entry-referenced names are tracked here.
   */
  usedCore: Set<string>;

  // App config presence (drives lifecycle/plugin emission).
  hasAppConfig: boolean;
  /**
   * Whether the app config actually registers hooks/plugins that run per
   * request. Distinct from `hasAppConfig`: a config that only sets `server`
   * options carries no lifecycle, so routes can still specialize/hoist.
   * Falls back to `hasAppConfig` when the config wasn't analyzed.
   */
  appConfigHasHooks: boolean;
  appConfigAbs: string | undefined;
  /**
   * Whether a `debugbar()` is kept for this build (baked into the
   * `__TRACE_DEBUG` module constant). When false, the lifecycle-stage
   * instrumentation is const-folded out of the artifact.
   */
  traceDebug: boolean;
  /**
   * Whether this build is production-shaped (baked as
   * `globalThis.__IGNEX_PROD_BUILD = true`). Dev-only plugins read it so a
   * production-built artifact stays toolbar-free even when launched without
   * `NODE_ENV=production` in the environment.
   */
  isProductionBuild: boolean;

  // Inlined handler bodies (self-contained modules emitted inline).
  inlineHandlers: Map<string, { body: string; isAsync: boolean; param: string }>;

  // WebSocket route `wsHandler` imports (route path → import name). A single
  // route is assigned directly to `Bun.serve.websocket`; multiple routes use
  // a per-path dispatcher (see server.ts).
  wsHandlers: Array<{ path: string; handler: string }>;

  // Route-table accumulation.
  routeEntries: Map<string, Map<string, string>>;
  explicitKeys: Set<string>;
  allowMethodsByPattern: Map<string, Set<string>>;
  wildcardsByPath: Map<string, string[]>;

  /**
   * Wrapper variant per TABLE-BOUND handler name (`methodHandlerName` — for
   * deduplicated members this is the leader's name, which `routeHandlerName`
   * resolves to). Recorded during pass 1 (`generateRouteCode` /
   * `emitConstantRoute`), consumed by pass 2. Missing ⇒ generic `__wrap`.
   */
  wrapVariants: Map<string, WrapVariant>;

  /** Refs of constant-hoisted GET routes (a build-time HEAD handler exists). */
  constantGets: Set<string>;

  /**
   * Import names of discovered realtime consumer modules (default-export
   * `register()`). Populated by the imports stage; the header stage emits the
   * registration call AFTER the plugin init loop (novaPlugin bound the hub).
   */
  realtimeConsumerRefs: string[];

  /**
   * Pre-built static `Response` consts keyed by TABLE-BOUND handler name
   * (`methodHandlerName`). When present, pass 2 binds the frozen Response
   * VALUE directly into Bun's native routes table — Bun then serves the route
   * entirely in Rust (zero per-request JS), with free auto-HEAD (body
   * stripped, content-length preserved) and conditional-GET handling. Only
   * registered for provably-constant routes on apps WITHOUT lifecycle hooks
   * (`tryNormalizeConstant(route, hasGlobalLifecycle)` already refuses those),
   * so skipping the JS pipeline cannot drop hook-driven mutations.
   */
  staticResponses: Map<string, string>;
}

export const createCodegenState = (cfg: CodegenConfig): CodegenState => ({
  cfg,
  imports: new Set(),
  header: [],
  cacheDecls: [],
  functions: [],
  usedCore: new Set(),
  hasAppConfig: false,
  appConfigHasHooks: false,
  appConfigAbs: undefined,
  traceDebug: false,
  isProductionBuild: false,
  inlineHandlers: new Map(),
  wsHandlers: [],
  routeEntries: new Map(),
  explicitKeys: new Set(),
  allowMethodsByPattern: new Map(),
  wildcardsByPath: new Map(),
  wrapVariants: new Map(),
  constantGets: new Set(),
  staticResponses: new Map(),
  realtimeConsumerRefs: [],
});
