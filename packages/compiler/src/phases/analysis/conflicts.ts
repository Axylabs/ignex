/**
 * @fileoverview Analysis: dead / duplicate / ambiguous route detection.
 */

import { DiagnosticCodes } from "../../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteDef } from "../../types";

export const staticRouteKey = (route: RouteDef): string =>
  `${route.source.method}:${route.source.path}`;

export const detectDeadRoutes = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
): { alive: RouteDef[]; dead: RouteDef[] } => {
  const seen = new Map<string, number>();
  const alive: RouteDef[] = [];
  const dead: RouteDef[] = [];

  for (const route of routes) {
    const moduleIdx = route.source.moduleIdx;
    const hasValidModule = moduleIdx >= 0 && moduleIdx < modules.length;
    if (!hasValidModule) {
      dead.push(route);
      continue;
    }
    if (route.source.isStatic && seen.has(staticRouteKey(route))) {
      dead.push(route);
      continue;
    }
    if (route.source.isStatic) {
      seen.set(staticRouteKey(route), alive.length);
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

const normalizeConflictPattern = (path: string): string =>
  path
    .split("/")
    .map((segment) => {
      if (segment.startsWith(":")) return ":param";
      if (segment.startsWith("*")) return "*";
      return segment;
    })
    .join("/");

export const detectRouteConflicts = (
  routes: readonly RouteDef[],
  opts: CompilerOptions,
  ctx: CompilerContext,
): void => {
  const issues: RouteConflictIssue[] = [];

  const exact = new Map<string, RouteDef[]>();
  const patterns = new Map<string, RouteDef[]>();

  for (const route of routes) {
    const routePath = route.source.path;
    const exactKey = `${route.source.method} ${routePath}`;
    const patternKey = `${route.source.method} ${normalizeConflictPattern(routePath)}`;

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
