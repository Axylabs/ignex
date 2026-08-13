/**
 * @fileoverview `manifest.json` artifact generation.
 */

import type { CompilerOptions, RouteIR } from "../../types";

export const generateManifest = (
  routes: readonly RouteIR[],
  opts: CompilerOptions,
): Record<string, unknown> => ({
  generatedAt: new Date().toISOString(),
  serviceName: opts.serviceName ?? "ignus",
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
  })),
});
