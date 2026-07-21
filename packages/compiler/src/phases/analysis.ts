/**
 * @fileoverview Phase 2: ANALYSIS — AST-based, zero regex.
 * Detects ctx usage at build time. Produces RouteDefs from discovered modules.
 */

import type {
  RouteDef,
  ModuleInfo,
  CompilerOptions,
  HttpMethod,
  DiscoveryResult,
  AnalysisResult,
  HookDef,
  ContextUsage,
  RouteCacheConfig,
} from "../types";

import { HTTP_METHODS, FULL_CONTEXT_USAGE } from "../types";
import { parseRouteFilename } from "./discovery";
import { computeSignatureHash } from "../utils/hash";
import {
  parseModule,
  isPureBodyAST,
  inferResponseTypeAST,
} from "../utils/ast";



import type { Logger } from "../logger";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { parseModule as parseModuleAST } from "../utils/ast";
import type { AppConfigInfo } from "../types";

const safeReadFile = (path: string): string => {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
};

export const resolveAppConfig = (
  opts: CompilerOptions,
): AppConfigInfo | undefined => {
  const relPath = opts.appConfig ?? "./src/app.config.ts";
  const absPath = join(process.cwd(), relPath);

  if (!existsSync(absPath)) {
    return undefined;
  }

  const content = safeReadFile(absPath);

  if (!content) {
    return undefined;
  }

  const parsed = parseModuleAST(content);
  const exportNames = new Set(parsed.exports.map((x) => x.name));

  return {
    path: absPath,
    relPath,
    hasPlugins: exportNames.has("plugins"),
    hasLifecycle:
      exportNames.has("lifecycle") || exportNames.has("hooks"),
    hasServer: exportNames.has("server"),
  };
};
// ============================================================================
// Pure Route Analysis Functions
// ============================================================================

export const parseRouteFile = (file: string) => parseRouteFilename(file);

export const findModuleByPath = (
  modules: readonly ModuleInfo[], relPath: string
): ModuleInfo | undefined => modules.find((m) => m.relPath === relPath);

export const findModuleIndex = (
  modules: readonly ModuleInfo[], relPath: string
): number => modules.findIndex((m) => m.relPath === relPath);

// ============================================================================
// Constant Response Detection
// ============================================================================

import { extractConstantReturn } from "../utils/ast";

const evaluateConstantBodyAST = (ast: any): string | null => {
  const result = extractConstantReturn(ast);
  if (!result.ok) return null;
  try {
    return JSON.stringify(result.value);
  } catch {
    return null;
  }
};

export const detectConstantResponse = (
  mod: ModuleInfo
): { isConstant: boolean; constantResponse?: string } => {
  const parsed = parseModule(mod.content);

  if (!parsed.handler) {
    return { isConstant: false };
  }

  if (!isPureBodyAST(parsed.ast)) {
    return { isConstant: false };
  }

  const json = evaluateConstantBodyAST(parsed.ast);

  if (!json) {
    return { isConstant: false };
  }

  return {
    isConstant: true,
    constantResponse: json,
  };
};

// ============================================================================
// RouteDef Factory — Pure
// ============================================================================

export const buildHandlerRef = (routeIndex: number): string => `_h${routeIndex}`;
export const buildSchemaRef = (routeIndex: number, hasSchema: boolean): string | null =>
  hasSchema ? `_s${routeIndex}` : null;
export const computeMethodIndex = (method: HttpMethod): number =>
  HTTP_METHODS.indexOf(method);

export const findHandlerSymbol = (mod: ModuleInfo) =>
  mod.symbols.find((s) => s.name === "default") || mod.symbols[0];
/**
 * Normalize exported route cache config.
 *
 * Pure and exactOptionalPropertyTypes-safe.
 */
const normalizeRouteCache = (
  input: unknown,
): RouteCacheConfig | undefined => {
  if (typeof input === "number") {
    return { maxAge: input };
  }

  if (!input || typeof input !== "object") {
    return undefined;
  }

  const cfg = input as Record<string, unknown>;

  const cache: {
    maxAge?: number;
    swr?: number;
    immutable?: boolean;
    vary?: string[];
  } = {};

  if (typeof cfg.maxAge === "number") cache.maxAge = cfg.maxAge;
  if (typeof cfg.swr === "number") cache.swr = cfg.swr;
  if (typeof cfg.immutable === "boolean") cache.immutable = cfg.immutable;

  if (Array.isArray(cfg.vary)) {
    cache.vary = cfg.vary.filter(
      (item): item is string => typeof item === "string",
    );
  }

  return Object.keys(cache).length > 0 ? cache : undefined;
};


export const createRouteDef = (
  file: string,
  parsed: NonNullable<ReturnType<typeof parseRouteFilename>>,
  mod: ModuleInfo,
  routeIndex: number,
  moduleIdx: number,
): RouteDef => {
  const handlerSym = findHandlerSymbol(mod);
  const methodIdx = computeMethodIndex(parsed.method);

  const astParsed = parseModule(mod.content);

  const cache = normalizeRouteCache(astParsed.config?.cache);
  const usage = astParsed.handler?.usage ?? FULL_CONTEXT_USAGE;

  const isAsync =
    astParsed.handler?.isAsync ?? handlerSym?.isAsync ?? false;

  const hooks = Array.isArray(astParsed.config?.hooks)
    ? astParsed.config.hooks.filter(
        (x: unknown): x is string => typeof x === "string",
      )
    : [];

  const { isConstant, constantResponse } = detectConstantResponse(mod);
  const inferredResponseType = inferResponseTypeAST(astParsed.ast);

  const responseType = usage.json
    ? "json"
    : usage.text
      ? "text"
      : usage.html
        ? "html"
        : usage.stream
          ? "stream"
          : inferredResponseType;

  return {
    ...parsed,
    file,
    moduleIdx,
    handlerRef: buildHandlerRef(routeIndex),
    schemaRef: buildSchemaRef(routeIndex, !!mod.schemaExport),
    signatureHash: computeSignatureHash(methodIdx, parsed.path),
    handlerSize: handlerSym?.size || 9999,
    isAsync,
    shouldInline: false,
    responseType,
    hasValidation: !!mod.schemaExport,
    hotnessScore: 0,
    hooks,
    isConstantResponse: isConstant,
    usage,

    ...(constantResponse !== undefined ? { constantResponse } : {}),
    ...(cache !== undefined ? { cache } : {}),
    ...(astParsed.config !== undefined ? { config: astParsed.config } : {}),
  };
};

export const resolveRouteModule = (
  file: string,
  modules: readonly ModuleInfo[]
): { mod: ModuleInfo; parsed: NonNullable<ReturnType<typeof parseRouteFilename>> } | null => {
  const parsed = parseRouteFile(file);
  if (!parsed) return null;
  const mod = findModuleByPath(modules, file);
  if (!mod) return null;
  if (!mod.hasDefaultExport) return null;
  return { mod, parsed };
};

// ============================================================================
// Route Graph Builder — Pure
// ============================================================================

export const buildRouteGraph = (
  files: readonly string[],
  modules: readonly ModuleInfo[]
): RouteDef[] => {
  const routes: RouteDef[] = [];

  for (const file of files) {
    const resolved = resolveRouteModule(file, modules);
    if (!resolved) continue;

    const moduleIdx = findModuleIndex(modules, file);
    if (moduleIdx < 0) continue;

    routes.push(
      createRouteDef(
        file,
        resolved.parsed,
        resolved.mod,
        routes.length,
        moduleIdx
      )
    );
  }

  return routes;
};
// ============================================================================
// Dead Route Detection — Pure
// ============================================================================

export const staticRouteKey = (route: RouteDef): string =>
  `${route.method}:${route.path}`;

export const detectDeadRoutes = (
  routes: readonly RouteDef[],
  modules: readonly ModuleInfo[]
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
  logger: Logger,
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
    if (issue.level === "error") {
      logger.error(issue.message, { routes: issue.routes });
    } else {
      logger.warn(issue.message, { routes: issue.routes });
    }
  }

  const hasError = issues.some((issue) => issue.level === "error");

  if (hasError && opts.strictRouteConflicts) {
    throw new Error("Route conflicts detected and strictRouteConflicts is enabled.");
  }
};

// ============================================================================
// Hook Resolution — Pure
// ============================================================================

export const collectHookNames = (routes: readonly RouteDef[]): Set<string> => {
  const referenced = new Set<string>();
  for (const route of routes) {
    for (const hook of route.hooks) referenced.add(hook);
  }
  return referenced;
};

export const createHookDef = (name: string, hooksDir: string): HookDef => ({
  name,
  source: `${hooksDir}/${name}.ts`,
  moduleIdx: -1,
  isAsync: true,
});

export const resolveHooks = (
  routes: readonly RouteDef[],
  hooksDir: string | undefined
): ReadonlyMap<string, HookDef> => {
  const names = collectHookNames(routes);
  const hooks = new Map<string, HookDef>();
  if (!hooksDir || names.size === 0) return hooks;
  for (const name of names) {
    hooks.set(name, createHookDef(name, hooksDir));
  }
  return hooks;
};

// ============================================================================
// Statistics — Pure
// ============================================================================

export const countRoutes = (
  routes: readonly RouteDef[],
  predicate: (r: RouteDef) => boolean
): number => routes.filter(predicate).length;

export const countStatic = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isStatic);
export const countDynamic = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isDynamic);
export const countConstant = (routes: readonly RouteDef[]): number =>
  countRoutes(routes, (r) => r.isConstantResponse);

// ============================================================================
// Phase Orchestrator — Composed from pure functions
// ============================================================================

export const runAnalysis = (
  discovery: DiscoveryResult,
  opts: CompilerOptions,
  logger: Logger,
): AnalysisResult =>
  logger.time("analysis", () => {
    const routes = buildRouteGraph(discovery.files, discovery.modules);
    const { alive, dead } = detectDeadRoutes(routes, discovery.modules);

    if (dead.length > 0) {
      logger.warn(`Eliminated ${dead.length} dead route(s)`, {
        dead: dead.map((r) => `${r.method} ${r.path}`),
      });
    }

    detectRouteConflicts(alive, opts, logger);

    const hooks = resolveHooks(alive, opts.hooksDir);
    const appConfig = resolveAppConfig(opts);

    if (appConfig) {
      logger.info(`App config found: ${appConfig.relPath}`, {
        plugins: appConfig.hasPlugins,
        lifecycle: appConfig.hasLifecycle,
        server: appConfig.hasServer,
      });
    }

    return {
      routes: alive,
      modules: discovery.modules,
      hooks,
      ...(appConfig ? { appConfig } : {}),
    };
  });