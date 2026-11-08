/**
 * @fileoverview CODEGEN phase — orchestrator + public facade.
 *
 * The code generator is grouped by concern into focused modules:
 *   ./config      — compile-time options flattened for emission
 *   ./identifiers — generated-identifier naming conventions
 *   ./helpers     — generated runtime helper sources (DCE at link time)
 *   ./decisions   — per-route decisions (constant/cache/inline)
 *   ./state       — shared mutable state threaded through the stages
 *   ./imports     — stage: app-config + per-route import assembly
 *   ./header      — stage: header constants + inlined handlers
 *   ./routes      — stage: per-route handler emission
 *   ./routetable  — stage: Bun route table + 405 lookup
 *   ./server      — stage: server bootstrap + core-import assembly
 *
 * `generateServer` composes the stages over a {@link CodegenState} in the
 * fixed order that determines output: imports → header → inlined handlers →
 * route table → server. Consumers import the whole phase from
 * `../phases/codegen` (this facade); the stage modules stay internal.
 */

import { DiagnosticCodes } from "../../diagnostics";
import type {
  AppConfigInfo,
  CompilerContext,
  CompilerOptions,
  HookDef,
  ModuleInfo,
  RouteIR,
} from "../../types";
import { isProductionBuild } from "../analysis/app-config";
import { getConfig } from "./config";
import { stageHeader, stageInlinedHandlers } from "./header";
import { stageImports } from "./imports";
import { stageRouteTable } from "./routetable";
import { stageServer } from "./server";
import { createCodegenState } from "./state";

export const generateServer = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  appConfig?: AppConfigInfo,
  realtimeConsumers: readonly string[] = [],
): string => {
  const cfg = getConfig(opts);
  const state = createCodegenState(cfg);

  // Compose the emission stages in the fixed order that determines output.
  stageImports(state, routes, modules, hooks, opts, appConfig, realtimeConsumers);
  stageHeader(state, opts);
  stageInlinedHandlers(state);
  stageRouteTable(state, routes, opts);
  return stageServer(state, opts);
};

export const runCodeGen = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  hooks: ReadonlyMap<string, HookDef>,
  opts: CompilerOptions,
  ctx: CompilerContext,
  appConfig?: AppConfigInfo,
  realtimeConsumers: readonly string[] = [],
): string => {
  // Loud escape hatch: the secure default forces `exposeErrorDetails: false`
  // onto production-shaped builds when the option is unset (validate.ts
  // mergeOptions), so reaching codegen with exposure ON means the artifact
  // will return real (redacted) error messages/details to clients. Never
  // silent — say so at build time.
  if (isProductionBuild(opts) && opts.exposeErrorDetails === true) {
    ctx.diagnostics.warn({
      code: DiagnosticCodes.ErrorsExposed,
      message:
        "exposeErrorDetails is explicitly ON for a production-shaped build — " +
        "clients will receive internal error messages/details (connection strings " +
        "are still redacted). Pass exposeErrorDetails: false to fail closed.",
    });
  }
  // Timing is owned by the pipeline stage that calls this (single
  // `logger.time("codegen")` entry — the phase itself does not re-wrap).
  return generateServer(routes, modules, hooks, opts, appConfig, realtimeConsumers);
};
