/**
 * @fileoverview Codegen: compile-time options flattened for emission.
 */

import { relative } from "node:path";
import type { CompilerOptions } from "../../types";

/** The runtime import specifier for `@ignex/core` (the generated server's only package dep). */
export const CORE_PATH = "@ignex/core";

export interface CodegenConfig {
  target: "bun";
  serviceName: string;
  exposeErrorDetails: boolean;
  specializeContext: boolean;
  reusePort: boolean;
  routeCache: boolean;
  hoistConstants: boolean;
  maxInlineBytes: number;
  inlineThreshold: number;
  enableTraceHeaders: boolean;
  enableAccessLog: boolean;
  /** Dev-only per-route request counter (see `./heat`). */
  heatCapture: boolean;
}

export const getConfig = (opts: CompilerOptions): CodegenConfig => ({
  target: opts.target,
  serviceName: opts.serviceName ?? "ignex",
  exposeErrorDetails: opts.exposeErrorDetails ?? false,
  specializeContext: opts.specializeContext ?? true,
  reusePort: opts.reusePort ?? false,
  routeCache: opts.routeCache ?? true,
  hoistConstants: opts.hoistConstants ?? true,
  maxInlineBytes: opts.maxInlineBytes ?? 2048,
  inlineThreshold: opts.inlineThreshold ?? 50,
  enableTraceHeaders: opts.enableTraceHeaders ?? false,
  enableAccessLog: opts.enableAccessLog ?? false,
  heatCapture: opts.heatCapture ?? false,
});

/** Convert an absolute module path into a relative import specifier (from `outDir`). */
export const toImportPath = (absPath: string, opts: CompilerOptions): string => {
  let rel = relative(opts.outDir, absPath)
    .replace(/\\/g, "/")
    .replace(/\.(ts|tsx|js|mjs|jsx)$/, "");

  if (!rel.startsWith(".")) rel = `./${rel}`;

  return rel;
};
