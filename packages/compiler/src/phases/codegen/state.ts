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

  // `@ignus/core` import assembly.
  coreNames: string[];
  uniqueCore: string[];

  // App config presence (drives lifecycle/plugin emission).
  hasAppConfig: boolean;
  appConfigAbs: string | undefined;

  // Inlined handler bodies (self-contained modules emitted inline).
  inlineHandlers: Map<string, { body: string; isAsync: boolean; param: string }>;

  // WebSocket route `wsHandler` import names (assigned to `Bun.serve.websocket`).
  wsHandlers: string[];

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
  appConfigAbs: undefined,
  inlineHandlers: new Map(),
  wsHandlers: [],
  routeEntries: new Map(),
  explicitKeys: new Set(),
  allowMethodsByPattern: new Map(),
  wildcardsByPath: new Map(),
});
