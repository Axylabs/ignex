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

const evaluateConstantBody = (body: string): string | null => {
  const expr = body
    .replace(/^return\s+/, "")
    .replace(/;\s*$/, "")
    .trim();

  if (!expr) return null;

  try {
    // Only called after isPureBodyAST() has approved the body.
    const fn = new Function(`"use strict"; return (${expr});`);
    const value = fn();
    return JSON.stringify(value);
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

  const json = evaluateConstantBody(parsed.handler.body);

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
  logger: Logger
): AnalysisResult =>
  logger.time("analysis", () => {
    const routes = buildRouteGraph(discovery.files, discovery.modules);
    const { alive, dead } = detectDeadRoutes(routes, discovery.modules);

    if (dead.length > 0) {
      logger.warn(`Eliminated ${dead.length} dead route(s)`, {
        dead: dead.map((r) => `${r.method} ${r.path}`),
      });
    }

    const hooks = resolveHooks(alive, opts.hooksDir);

    const needsBody = alive.filter((r) => r.usage.body).length;
    const needsFile = alive.filter((r) => r.usage.file).length;
    const needsQuery = alive.filter((r) => r.usage.query).length;

    logger.info(
      `Routes: ${alive.length} total (${countStatic(alive)} static, ${countDynamic(alive)} dynamic, ${countConstant(alive)} constant)`
    );
    logger.info(
      `Usage analysis: ${needsBody} need body | ${needsFile} need files | ${needsQuery} need query`
    );

    if (hooks.size > 0) {
      logger.info(`Hooks resolved: ${[...hooks.keys()].join(", ")}`);
    }

    return { routes: alive, modules: discovery.modules, hooks };
  });
