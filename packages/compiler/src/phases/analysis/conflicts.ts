/**
 * @fileoverview Analysis: dead / duplicate / ambiguous route detection.
 */

import { DiagnosticCodes } from "../../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteIR } from "../../types";
import { normalizePathPattern } from "../../utils/route-path";

export const staticRouteKey = (route: RouteIR): string =>
  `${route.source.method}:${route.source.path}`;

export const detectDeadRoutes = (
  routes: readonly RouteIR[],
  modules: readonly ModuleInfo[],
  opts: { strictDuplicates?: boolean } = {},
  ctx?: CompilerContext,
): { alive: RouteIR[]; dead: RouteIR[] } => {
  const seen = new Map<string, RouteIR>();
  const alive: RouteIR[] = [];
  const dead: RouteIR[] = [];

  for (const route of routes) {
    const moduleIdx = route.source.moduleIdx;
    const hasValidModule = moduleIdx >= 0 && moduleIdx < modules.length;
    if (!hasValidModule) {
      dead.push(route);
      continue;
    }
    if (route.source.isStatic) {
      const key = staticRouteKey(route);
      const existing = seen.get(key);
      if (existing) {
        // Exact static duplicate. Under `strictRouteConflicts` this is FATAL:
        // emit an error diagnostic so the pipeline's final `hasErrors` gate
        // fails the build. (Previously `detectDeadRoutes` deduped BEFORE
        // `detectRouteConflicts`, so an exact duplicate could never reach the
        // duplicate-route error path — even in strict mode.)
        if (opts.strictDuplicates && ctx) {
          ctx.diagnostics.error({
            code: DiagnosticCodes.RouteConflict,
            message: `Duplicate route: ${route.source.method} ${route.source.path}`,
            file: route.source.file,
            related: [
              {
                code: DiagnosticCodes.RouteConflict,
                severity: "info",
                message: "First defined here",
                file: existing.source.file,
              },
            ],
          });
        }
        dead.push(route);
        continue;
      }
      seen.set(key, route);
    }
    alive.push(route);
  }
  return { alive, dead };
};

export interface RouteConflictIssue {
  readonly level: "error" | "warn";
  readonly message: string;
  readonly routes: readonly string[];
}

export const detectRouteConflicts = (
  routes: readonly RouteIR[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): void => {
  const issues: RouteConflictIssue[] = [];

  const exact = new Map<string, RouteIR[]>();
  const patterns = new Map<string, RouteIR[]>();

  for (const route of routes) {
    const routePath = route.source.path;
    const exactKey = `${route.source.method} ${routePath}`;
    const patternKey = `${route.source.method} ${normalizePathPattern(routePath)}`;

    const exactGroup = exact.get(exactKey);
    if (exactGroup) exactGroup.push(route);
    else exact.set(exactKey, [route]);

    const patternGroup = patterns.get(patternKey);
    if (patternGroup) patternGroup.push(route);
    else patterns.set(patternKey, [route]);
  }

  for (const [key, group] of exact) {
    if (group.length > 1) {
      issues.push({
        level: "error",
        message: `Duplicate route: ${key}`,
        routes: group.map((r) => r.source.file),
      });
    }
  }

  for (const [key, group] of patterns) {
    if (group.length <= 1) continue;

    const uniquePaths = new Set(group.map((r) => r.source.path));

    if (uniquePaths.size > 1) {
      issues.push({
        level: "warn",
        message: `Ambiguous dynamic route pattern: ${key}`,
        routes: group.map((r) => `${r.source.method} ${r.source.path} -> ${r.source.file}`),
      });
    }
  }

  const fatal = opts.strictRouteConflicts;

  for (const issue of issues) {
    const code =
      issue.level === "error" ? DiagnosticCodes.RouteConflict : DiagnosticCodes.AmbiguousRoute;
    const isError = issue.level === "error" && fatal;

    // `strictRouteConflicts` makes error-level conflicts fatal: report them as
    // error diagnostics so the pipeline's final `hasErrors` check produces a
    // structured summary — instead of a mid-pipeline throw that bypasses it.
    ctx.diagnostics[isError ? "error" : "warn"]({
      code,
      message: issue.message,
      file: issue.routes[0],
    });
  }
};
