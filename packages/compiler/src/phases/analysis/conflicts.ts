/**
 * @fileoverview Analysis: dead / duplicate / ambiguous route detection.
 */

import { DiagnosticCodes } from "../../diagnostics";
import type { CompilerContext, CompilerOptions, ModuleInfo, RouteDef } from "../../types";

export const staticRouteKey = (route: RouteDef): string => `${route.method}:${route.path}`;

export const detectDeadRoutes = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[],
): { alive: RouteDef[]; dead: RouteDef[] } => {
  const seen = new Map<string, number>();
  const alive: RouteDef[] = [];
  const dead: RouteDef[] = [];

  for (const route of routes) {
    const hasValidModule = route.moduleIdx >= 0 && route.moduleIdx < modules.length;
    if (!hasValidModule) {
      dead.push(route);
      continue;
    }
    if (route.isStatic && seen.has(staticRouteKey(route))) {
      dead.push(route);
      continue;
    }
    if (route.isStatic) {
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
    const exactKey = `${route.method} ${route.path}`;
    const patternKey = `${route.method} ${normalizeConflictPattern(route.path)}`;

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
        routes: group.map((r) => r.file),
      });
    }
  }

  for (const [key, group] of patterns) {
    if (group.length <= 1) continue;

    const uniquePaths = new Set(group.map((r) => r.path));

    if (uniquePaths.size > 1) {
      issues.push({
        level: "warn",
        message: `Ambiguous dynamic route pattern: ${key}`,
        routes: group.map((r) => `${r.method} ${r.path} -> ${r.file}`),
      });
    }
  }

  for (const issue of issues) {
    ctx.diagnostics.warn({
      code:
        issue.level === "error" ? DiagnosticCodes.RouteConflict : DiagnosticCodes.AmbiguousRoute,
      message: issue.message,
      file: issue.routes[0],
    });
  }

  const hasError = issues.some((issue) => issue.level === "error");

  if (hasError && opts.strictRouteConflicts) {
    throw new Error("Route conflicts detected and strictRouteConflicts is enabled.");
  }
};
