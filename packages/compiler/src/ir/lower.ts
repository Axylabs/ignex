/**
 * @fileoverview Route IR lowering.
 *
 * The lowering step converts a route's source facts into a {@link RouteIR}:
 * the route filename encodes method/path/params (file-based routing is a
 * deliberate framework convention — here it is made an explicit, pure input
 * to lowering rather than ad-hoc string handling), and the module's retained
 * AST supplies the semantic facts (handler, usage, config, constant response).
 *
 * Lowering is a pure function of (filename, {@link SourceFile}); the IR it
 * produces is the single object every later phase consumes.
 */

import { basename, dirname, extname, join } from "node:path";
import type { SourceFile } from "../frontend/source-file";
import type { HttpMethod, ModuleInfo, RouteCacheConfig, SymbolInfo } from "../types";
import { FULL_CONTEXT_USAGE, normalizeHttpMethod } from "../types";
import { extractConstantReturn, inferResponseTypeAST, isPureBodyAST } from "../utils/ast";
import type { RouteIR, RouteIRSource } from "./route";

// ── Filename → route source ───────────────────────────────────────

/**
 * Parse a route file's path into its route source facts. The file-based
 * routing convention (method suffix, `[param]` / `[...rest]` segments) is
 * decoded here — the single place this convention is interpreted.
 */
export const parseRouteFilename = (
  file: string,
): Pick<
  RouteIRSource,
  "method" | "path" | "paramNames" | "isDynamic" | "isStatic" | "segmentCount"
> | null => {
  const ext = extname(file);
  const name = basename(file, ext);
  const parts = name.split(".");

  let method: HttpMethod = "GET";
  let routeName = name;

  const lastPart = parts.at(-1);
  if (lastPart) {
    const normalized = normalizeHttpMethod(lastPart);
    if (normalized) {
      method = normalized;
      routeName = parts.slice(0, -1).join(".");
    }
  }

  const dirPart = dirname(file);
  let routePath = `/${join(dirPart, routeName).replace(/\\/g, "/")}`;
  if (routePath.endsWith("/index")) {
    routePath = routePath.slice(0, -5) || "/";
  }

  const paramNames: string[] = [];
  let isDynamic = false;

  routePath = routePath.replace(/\[(\.\.\.[^\]]+)\]/g, (_, raw: string) => {
    isDynamic = true;
    const pname = raw.slice(3);
    paramNames.push(pname);
    return `*${pname}`;
  });

  routePath = routePath.replace(/\[([^\]]+)\]/g, (_, pname: string) => {
    isDynamic = true;
    paramNames.push(pname);
    return `:${pname}`;
  });

  return {
    method,
    path: routePath,
    paramNames,
    isDynamic,
    isStatic: !isDynamic,
    segmentCount: routePath.split("/").filter(Boolean).length,
  };
};

// ── Pure helpers (moved from analysis/route-graph) ───────────────

export const buildHandlerRef = (routeIndex: number): string => `_h${routeIndex}`;

export const findHandlerSymbol = (mod: ModuleInfo): SymbolInfo | undefined =>
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
  mod: SourceFile,
): { isConstant: boolean; constantResponse?: string } => {
  // Uses the AST + handler retained on the SourceFile from discovery — no re-parse.
  const handler = mod.handler;

  if (!handler) {
    return { isConstant: false };
  }

  if (!isPureBodyAST(mod.ast)) {
    return { isConstant: false };
  }

  const json = evaluateConstantBodyAST(mod.ast);

  if (!json) {
    return { isConstant: false };
  }

  return {
    isConstant: true,
    constantResponse: json,
  };
};

// ── Lowering ─────────────────────────────────────────────────────

/**
 * Lower a route module into its {@link RouteIR}. Pure: consumes the parsed
 * filename facts and the module's retained AST, never re-parsing source.
 */
export const lowerRoute = (
  file: string,
  parsed: NonNullable<ReturnType<typeof parseRouteFilename>>,
  mod: SourceFile,
  routeIndex: number,
  moduleIdx: number,
): RouteIR => {
  const handlerSym = findHandlerSymbol(mod);

  // All AST-derived facts come from the retained SourceFile (no re-parse).
  const cache = normalizeRouteCache(mod.config?.cache);
  const usage = mod.handler?.usage ?? FULL_CONTEXT_USAGE;

  const isAsync = mod.handler?.isAsync ?? handlerSym?.isAsync ?? false;

  const hooks = Array.isArray(mod.config?.hooks)
    ? mod.config.hooks.filter((x: unknown): x is string => typeof x === "string")
    : [];

  const { isConstant, constantResponse } = detectConstantResponse(mod);
  const inferredResponseType = inferResponseTypeAST(mod.ast);

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
    source: {
      method: parsed.method,
      path: parsed.path,
      paramNames: parsed.paramNames,
      isDynamic: parsed.isDynamic,
      isStatic: parsed.isStatic,
      segmentCount: parsed.segmentCount,
      file,
      moduleIdx,
    },
    analysis: {
      isAsync,
      responseType,
      hasValidation: !!mod.schemaExport,
      hotnessScore: 0,
      hooks,
      isConstantResponse: isConstant,
      usage,

      ...(constantResponse !== undefined ? { constantResponse } : {}),
      ...(cache !== undefined ? { cache } : {}),
      ...(mod.config !== undefined ? { config: mod.config } : {}),
      ...(mod.handlerExportName !== undefined ? { handlerExportName: mod.handlerExportName } : {}),
    },
    decisions: {
      shouldInline: false,
    },
    codegen: {
      handlerRef: buildHandlerRef(routeIndex),
    },
  };
};
