/**
 * @fileoverview `manifest.json` artifact generation.
 */

import type { CompilerOptions, RouteIR } from "../../types";

/**
 * Generate the build `manifest.json` — per-route metadata (method, path,
 * file, response type, usage) for tooling and observability.
 *
 * NOTE: deliberately NO wall-clock timestamp. The manifest must be a pure
 * function of the build inputs — an embedded `generatedAt` changed the file
 * content on every rebuild (even no-op incremental ones), defeating
 * content-diffed writes and churning watchers/SDK caches.
 */
export const generateManifest = (
  routes: readonly RouteIR[],
  opts: CompilerOptions,
): Record<string, unknown> => ({
  version: 1,
  serviceName: opts.serviceName ?? "ignex",
  target: opts.target,
  optimizationLevel: opts.optimizationLevel,
  routes: routes.map((r) => ({
    method: r.source.method,
    path: r.source.path,
    file: r.source.file,
    isStatic: r.source.isStatic,
    isDynamic: r.source.isDynamic,
    segmentCount: r.source.segmentCount,
    isConstantResponse: r.analysis.isConstantResponse,
    responseType: r.analysis.responseType,
    hotnessScore: r.analysis.hotnessScore,
    paramNames: r.source.paramNames,
    hooks: r.analysis.hooks,
    usage: r.analysis.usage,
    // Hook wiring + optimization decisions: `ignex route:list` surfaces these
    // so a silent "my guard never ran" report is diagnosable from the build
    // output alone (runtime `before` chains live on handler.config; static
    // guards are emitted as __guard_* consts; inlined handlers cannot carry
    // runtime hooks).
    localHooks: r.analysis.localHooks,
    wrappedHandler: r.analysis.wrappedHandler,
    configExport: r.analysis.configExport,
    shouldInline: r.decisions.shouldInline,
    ...(r.analysis.guards ? { guards: r.analysis.guards } : {}),
    ...(r.analysis.schemaParts ? { schemaParts: r.analysis.schemaParts } : {}),
  })),
});
