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
import { safeReadFile } from "./fs";

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

  // Parse once through the source layer (no diagnostics — matches legacy
  // silent parse of the app config). The SourceFile retains the AST.
  const source = sources.fromSource(absPath, relPath, content);
  const exportNames = new Set(source.exports.map((x) => x.name));

  return {
    path: absPath,
    relPath,
    hasPlugins: exportNames.has("plugins"),
    hasLifecycle: exportNames.has("lifecycle") || exportNames.has("hooks"),
    hasServer: exportNames.has("server"),
  };
};
