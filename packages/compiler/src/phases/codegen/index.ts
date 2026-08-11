/**
 * @fileoverview CODEGEN phase — orchestrator + public facade.
 *
 * The code generator is grouped by concern into focused modules:
 *   ./config      — compile-time options flattened for emission
 *   ./identifiers — generated-identifier naming conventions
 *   ./helpers     — runtime helper registry (dependency-aware pruning)
 *   ./decisions   — per-route decisions (constant/cache/inline)
 *   ./state       — shared mutable state threaded through the stages
 *   ./imports     — stage: `@ignus/core` + per-route import assembly
 *   ./header      — stage: header constants + inlined handlers
 *   ./routes      — stage: per-route handler emission
 *   ./routetable  — stage: Bun route table + 405 lookup
 *   ./server      — stage: server bootstrap + helper pruning + assembly
 *
 * `generateServer` composes the stages over a {@link CodegenState} in the
 * fixed order that determines output: imports → header → inlined handlers →
 * route table → server. Consumers import the whole phase from
 * `../phases/codegen` (this facade).
 */

export { CORE_PATH, type CodegenConfig, getConfig, toImportPath } from "./config";
export { getCacheConfig, tryNormalizeConstant } from "./decisions";
export { stageHeader, stageInlinedHandlers } from "./header";
export { HELPER_SOURCES, HELPERS, indentBody, resolveUsedHelpers } from "./helpers";
export {
  allowRegExp,
  BUN_ALL_METHODS,
  cacheVar,
  constantBodyVar,
  constantInitVar,
  coreHandlerName,
  escapeRegExp,
  handlerImportName,
  hookIdent,
  methodHandlerName,
  routeHandlerName,
  routeReplyFn,
  serializerImportName,
  validatorImportName,
  wildcardNames,
} from "./identifiers";
export { stageImports } from "./imports";
export { generateRouteCode } from "./routes";
export { stageRouteTable } from "./routetable";
export { stageServer } from "./server";
export { type CodegenState, createCodegenState } from "./state";

import { Emitter } from "../../emitter";
import type { CompilerContext, CompilerOptions, HookDef, ModuleInfo, RouteDef } from "../../types";
import { getConfig } from "./config";
import { stageHeader, stageInlinedHandlers } from "./header";
import { stageImports } from "./imports";
import { stageRouteTable } from "./routetable";
import { stageServer } from "./server";
import { createCodegenState } from "./state";

export const generateServer = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
): string => {
  const cfg = getConfig(opts);
  const state = createCodegenState(cfg, new Emitter());

  // Compose the emission stages in the fixed order that determines output.
  stageImports(state, routes, modules, hooks, opts);
  stageHeader(state, opts);
  stageInlinedHandlers(state);
  stageRouteTable(state, routes, opts);
  return stageServer(state, opts);
};

export const runCodeGen = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  ctx: CompilerContext,
): string => ctx.logger.time("codegen", () => generateServer(routes, modules, hooks, opts));
