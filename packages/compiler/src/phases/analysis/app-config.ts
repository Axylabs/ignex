/**
 * @fileoverview Analysis: app-config detection (`./src/app.config.ts`).
 */

import { existsSync } from "node:fs";
import type { AppConfigInfo, CompilerOptions } from "../../types";
import { parseModule } from "../../utils/ast";
import { projectPath } from "../../utils/path";
import { safeReadFile } from "./fs";

export const resolveAppConfig = (opts: CompilerOptions): AppConfigInfo | undefined => {
  const relPath = opts.appConfig ?? "./src/app.config.ts";
  const absPath = projectPath(relPath);

  if (!existsSync(absPath)) {
    return undefined;
  }

  const content = safeReadFile(absPath);

  if (!content) {
    return undefined;
  }

  const parsed = parseModule(content);
  const exportNames = new Set(parsed.exports.map((x) => x.name));

  return {
    path: absPath,
    relPath,
    hasPlugins: exportNames.has("plugins"),
    hasLifecycle: exportNames.has("lifecycle") || exportNames.has("hooks"),
    hasServer: exportNames.has("server"),
  };
};
