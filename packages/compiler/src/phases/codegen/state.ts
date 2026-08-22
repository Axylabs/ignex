/**
 * @fileoverview Codegen: shared mutable state threaded through the emission
 * stages. Each stage appends to its own section so the final assembly order
 * (imports → header → helpers → cache decls → functions) is deterministic.
 */

import type { Emitter } from "../../emitter";
import type { CodegenConfig } from "./config";

export interface CodegenState {
  cfg: CodegenConfig;

  // Emitted sections (assembled in this order at the end).
  imports: Set<string>;
  header: string[];
  cacheDecls: string[];
  functions: string[];

  // Helper usage tracking (dead-code elimination of generated boilerplate).
  helpers: Emitter;

  // `@ignex/core` import assembly.
  coreNames: string[];
  uniqueCore: string[];

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
}

export const createCodegenState = (cfg: CodegenConfig, helpers: Emitter): CodegenState => ({
  cfg,
  imports: new Set(),
  header: [],
  cacheDecls: [],
  functions: [],
  helpers,
  coreNames: [],
  uniqueCore: [],
  hasAppConfig: false,
  appConfigHasHooks: false,
  appConfigAbs: undefined,
  traceDebug: false,
  inlineHandlers: new Map(),
  wsHandlers: [],
  routeEntries: new Map(),
  explicitKeys: new Set(),
  allowMethodsByPattern: new Map(),
  wildcardsByPath: new Map(),
});
