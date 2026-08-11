/**
 * @fileoverview Analysis: route hook resolution (`hooksDir` modules).
 */

import { existsSync } from "node:fs";
import { DiagnosticCodes } from "../../diagnostics";
import type { CompilerContext, HookDef, RouteDef } from "../../types";
import { parseModule } from "../../utils/ast";
import { projectPath } from "../../utils/path";
import { safeReadFile } from "./fs";

export const collectHookNames = (routes: readonly RouteDef[]): Set<string> => {
  const referenced = new Set<string>();
  for (const route of routes) {
    for (const hook of route.hooks) referenced.add(hook);
  }
  return referenced;
};

/**
 * Resolve and validate a single hook module: it must exist under `hooksDir`
 * and parse successfully. Emits `FLX_HOOK_MISSING` when it does not.
 */
export const resolveHook = (
  name: string,
  hooksDir: string,
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
  const parsed = parseModule(content, ctx?.diagnostics);
  const isAsync = parsed.handler?.isAsync ?? parsed.symbols.some((s) => s.isAsync) ?? true;

  return { name, source: abs, moduleIdx: -1, isAsync };
};

export const resolveHooks = (
  routes: readonly RouteDef[],
  hooksDir: string | undefined,
  ctx?: CompilerContext,
): ReadonlyMap<string, HookDef> => {
  const names = collectHookNames(routes);
  const hooks = new Map<string, HookDef>();
  if (!hooksDir || names.size === 0) return hooks;

  for (const name of names) {
    const hook = resolveHook(name, hooksDir, ctx);
    if (hook) hooks.set(name, hook);
  }

  return hooks;
};
