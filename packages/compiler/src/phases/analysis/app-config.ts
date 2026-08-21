/**
 * @fileoverview Analysis: app-config detection (`./src/app.config.ts`).
 *
 * Reads the app config through the build's {@link SourceManager} so every
 * file the compiler touches (routes, app config, hooks) flows through the
 * single source layer. Parsing is exactly-once: the retained `SourceFile`
 * supplies the export names.
 */

import { existsSync } from "node:fs";
import { DiagnosticCodes } from "../../diagnostics";
import type { SourceManager } from "../../frontend";
import type { AppConfigInfo, CompilerContext, CompilerOptions } from "../../types";
import { projectPath } from "../../utils/path";
import { analyzeDevOnlyPlugins } from "./dev-only-plugins";
import { safeReadFile } from "./fs";

/**
 * Is this build production-shaped? Production builds bake `NODE_ENV=production`
 * (`--compile`) or run with it set, and unless `IGNEX_DEBUG=1` is set at build
 * time the default-enabled `debugbar()` is provably disabled — so the compiler
 * can eliminate it and keep every AOT optimization (constant hoisting,
 * context specialization) for the shipped artifact.
 */
export const isProductionBuild = (opts: CompilerOptions): boolean =>
  (opts.compile === true || process.env.NODE_ENV === "production") &&
  process.env.IGNEX_DEBUG !== "1";

export const resolveAppConfig = (
  opts: CompilerOptions,
  sources: SourceManager,
  ctx: CompilerContext,
): AppConfigInfo | undefined => {
  const relPath = opts.appConfig ?? "./src/app.config.ts";
  const absPath = projectPath(relPath);

  if (!existsSync(absPath)) {
    return undefined;
  }

  const content = safeReadFile(absPath);

  if (!content) {
    // The file exists but could not be read (permissions, transient IO).
    // Surface it instead of silently treating the app as config-less, which
    // would silently drop plugins/lifecycle/server wiring.
    ctx.diagnostics.warn({
      code: DiagnosticCodes.IoReadFailed,
      message: `App config exists but could not be read: ${relPath}`,
      file: absPath,
    });
    return undefined;
  }

  // Parse once through the source layer. Diagnostics flow so a syntax error in
  // the app config is surfaced as a BUILD ERROR (previously a silent parse that
  // produced a cryptic boot-time module failure in the generated server). The
  // SourceFile retains the AST.
  const source = sources.fromSource(absPath, relPath, content, ctx.diagnostics);
  const exportNames = new Set(source.exports.map((x) => x.name));
  const hasPlugins = exportNames.has("plugins");
  const hasLifecycle = exportNames.has("lifecycle") || exportNames.has("hooks");

  // A `plugins` export whose only elements are always-disabled dev-only
  // plugins (debugbar) contributes no per-request hooks: drop it from the AOT
  // optimization decision. The runtime lifecycle is cleaned separately in
  // codegen (the `__ignexDevOnly` filter), so build-time and runtime agree.
  const devOnly = analyzeDevOnlyPlugins(source, isProductionBuild(opts));
  const hasActivePlugins =
    hasPlugins && !(devOnly.eliminated > 0 && devOnly.eliminated === devOnly.totalElements);

  return {
    path: absPath,
    relPath,
    hasPlugins,
    hasLifecycle,
    hasServer: exportNames.has("server"),
    hasActivePlugins,
  };
};
