/**
 * @fileoverview Analysis: route hook resolution (`hooksDir` modules).
 */

import { existsSync } from "node:fs";
import { DiagnosticCodes } from "../../diagnostics";
import type { SourceManager } from "../../frontend";
import type { CompilerContext, HookDef, RouteDef } from "../../types";
import { projectPath } from "../../utils/path";
import { safeReadFile } from "./fs";

export const collectHookNames = (routes: readonly RouteDef[]): Set<string> => {
  const referenced = new Set<string>();
  for (const route of routes) {
    for (const hook of route.analysis.hooks) referenced.add(hook);
  }
  return referenced;
};

/**
 * Resolve and validate a single hook module: it must exist under `hooksDir`
 * and parse successfully. Emits `FLX_HOOK_MISSING` when it does not. The
 * module is read + parsed through the build's {@link SourceManager} (once).
 */
export const resolveHook = (
  name: string,
  hooksDir: string,
  sources: SourceManager,
  ctx?: CompilerContext,
): HookDef | undefined => {
  const rel = `${hooksDir}/${name}.ts`;
  const abs = projectPath(rel);

  if (!existsSync(abs)) {
    ctx?.diagnostics.warn({
      code: DiagnosticCodes.HookMissing,
      message: `Route references hook '${name}' but '${rel}' does not exist.`,
      file: abs,
    });
    return undefined;
  }

  const content = safeReadFile(abs);
  const parsed = sources.fromSource(abs, rel, content, ctx?.diagnostics);
  const isAsync = parsed.handler?.isAsync ?? parsed.symbols.some((s) => s.isAsync) ?? true;

  return { name, source: abs, moduleIdx: -1, isAsync };
};

export const resolveHooks = (
  routes: readonly RouteDef[],
  hooksDir: string | undefined,
  sources: SourceManager,
  ctx?: CompilerContext,
): ReadonlyMap<string, HookDef> => {
  const names = collectHookNames(routes);
  const hooks = new Map<string, HookDef>();
  if (!hooksDir || names.size === 0) return hooks;

  for (const name of names) {
    const hook = resolveHook(name, hooksDir, sources, ctx);
    if (hook) hooks.set(name, hook);
  }

  return hooks;
};
