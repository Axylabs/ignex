/**
 * @fileoverview Analysis: route graph construction.
 *
 * Builds `RouteDef`s from discovered modules: filename parsing, constant
 * response detection, handler refs, cache normalization and the graph.
 */

import type { DiagnosticCollector } from "../../diagnostics";
import type { HttpMethod, ModuleInfo, RouteCacheConfig, RouteDef } from "../../types";
import { FULL_CONTEXT_USAGE, HTTP_METHODS } from "../../types";
import {
  extractConstantReturn,
  inferResponseTypeAST,
  isPureBodyAST,
  parseModule,
} from "../../utils/ast";
import { parseRouteFilename } from "../discovery";

export const parseRouteFile = (file: string) => parseRouteFilename(file);

export const findModuleByPath = (
  modules: readonly ModuleInfo[],
  relPath: string,
): ModuleInfo | undefined => modules.find((m) => m.relPath === relPath);

export const findModuleIndex = (modules: readonly ModuleInfo[], relPath: string): number =>
  modules.findIndex((m) => m.relPath === relPath);

// ── Constant response detection ──────────────────────────────────

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
  mod: ModuleInfo,
  diagnostics?: DiagnosticCollector,
): { isConstant: boolean; constantResponse?: string } => {
  const parsed = parseModule(mod.content, diagnostics);

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

// ── RouteDef factory ─────────────────────────────────────────────

export const buildHandlerRef = (routeIndex: number): string => `_h${routeIndex}`;
export const computeMethodIndex = (method: HttpMethod): number => HTTP_METHODS.indexOf(method);

export const findHandlerSymbol = (mod: ModuleInfo) =>
  mod.symbols.find((s) => s.name === "default") || mod.symbols[0];

/**
 * Normalize exported route cache config.
 * Pure and exactOptionalPropertyTypes-safe.
 */
const normalizeRouteCache = (input: unknown): RouteCacheConfig | undefined => {
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
    cache.vary = cfg.vary.filter((item): item is string => typeof item === "string");
  }

  return Object.keys(cache).length > 0 ? cache : undefined;
};

export const createRouteDef = (
  file: string,
  parsed: NonNullable<ReturnType<typeof parseRouteFilename>>,
  mod: ModuleInfo,
  routeIndex: number,
  moduleIdx: number,
  diagnostics?: DiagnosticCollector,
): RouteDef => {
  const handlerSym = findHandlerSymbol(mod);

  const astParsed = parseModule(mod.content, diagnostics);

  const cache = normalizeRouteCache(astParsed.config?.cache);
  const usage = astParsed.handler?.usage ?? FULL_CONTEXT_USAGE;

  const isAsync = astParsed.handler?.isAsync ?? handlerSym?.isAsync ?? false;

  const hooks = Array.isArray(astParsed.config?.hooks)
    ? astParsed.config.hooks.filter((x: unknown): x is string => typeof x === "string")
    : [];

  const { isConstant, constantResponse } = detectConstantResponse(mod, diagnostics);
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
    ...(astParsed.handlerExportName !== undefined
      ? { handlerExportName: astParsed.handlerExportName }
      : {}),
  };
};

export const resolveRouteModule = (
  file: string,
  modules: readonly ModuleInfo[],
): { mod: ModuleInfo; parsed: NonNullable<ReturnType<typeof parseRouteFilename>> } | null => {
  const parsed = parseRouteFile(file);
  if (!parsed) return null;
  const mod = findModuleByPath(modules, file);
  if (!mod) return null;
  // Accept default-export handlers AND named-export handlers
  // (`export const httpGet = get(...)`, `export function httpGet(...)`).
  if (!mod.hasHandlerExport) return null;
  return { mod, parsed };
};

export const buildRouteGraph = (
  files: readonly string[],
  modules: readonly ModuleInfo[],
  diagnostics?: DiagnosticCollector,
): RouteDef[] => {
  const routes: RouteDef[] = [];

  for (const file of files) {
    const resolved = resolveRouteModule(file, modules);
    if (!resolved) continue;

    const moduleIdx = findModuleIndex(modules, file);
    if (moduleIdx < 0) continue;

    routes.push(
      createRouteDef(file, resolved.parsed, resolved.mod, routes.length, moduleIdx, diagnostics),
    );
  }

  return routes;
};
