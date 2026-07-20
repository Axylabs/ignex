/**
 * @fileoverview Phase 1: DISCOVERY
 * Scans filesystem for route files and extracts module metadata via AST.
 * IO isolated in entry function. Pure functions do parsing.
 * Now with functional composition and error recovery.
 */

import { readdirSync, statSync, readFileSync } from "fs";
import { join, dirname, basename, extname } from "path";

import type {
  ModuleInfo,
  RouteDef,
  HttpMethod,
  CompilerOptions,
  DiscoveryResult,
} from "../types";

import { HTTP_METHODS } from "../types";
import { parseModule as parseModuleAST } from "../utils/ast";
import type { Logger } from "../logger";
import { tryCatch } from "../fp";

// Pure Functions
export const isRouteFile = (entry: string): boolean =>
  /\.(ts|js|mjs|tsx|jsx)$/.test(entry) && !entry.endsWith(".d.ts");

export const isValidDir = (entry: string): boolean =>
  !entry.startsWith(".") && entry !== "node_modules";

/** Safely read directory, returning empty array on error. */
const safeReaddir = (dir: string): string[] => {
  const result = tryCatch(() => readdirSync(dir));
  return result.ok ? result.value : [];
};

/** Safely check if path is directory. */
const safeIsDir = (path: string): boolean => {
  const result = tryCatch(() => statSync(path).isDirectory());
  return result.ok ? result.value : false;
};

/** Safely read file, returning empty string on error. */
const safeReadFile = (path: string): string => {
  const result = tryCatch(() => readFileSync(path, "utf-8"));
  return result.ok ? result.value : "";
};
export const scanDirectory = (dir: string, base = ""): string[] => {
  const out: string[] = [];
  for (const entry of safeReaddir(dir)) {
    const abs = join(dir, entry);
    const rel = join(base, entry).replace(/\\/g, "/");
    if (safeIsDir(abs)) {
      if (isValidDir(entry)) {
        out.push(...scanDirectory(abs, rel));
      }
    } else if (isRouteFile(entry)) {
      out.push(rel);
    }
  }
  return out;
};

export const parseRouteFilename = (
  file: string
): Pick<RouteDef, "method" | "path" | "paramNames" | "isDynamic" | "isStatic" | "segmentCount"> | null => {
  const ext = extname(file);
  const name = basename(file, ext);
  const parts = name.split(".");

  let method: HttpMethod = "GET";
  let routeName = name;

  const lastPart = parts.at(-1);
  if (lastPart && HTTP_METHODS.includes(lastPart.toUpperCase() as HttpMethod)) {
    method = lastPart.toUpperCase() as HttpMethod;
    routeName = parts.slice(0, -1).join(".");
  }

  const dirPart = dirname(file);
  let routePath = "/" + join(dirPart, routeName).replace(/\\/g, "/");
  if (routePath.endsWith("/index")) {
    routePath = routePath.slice(0, -5) || "/";
  }

  const paramNames: string[] = [];
  let isDynamic = false;

  routePath = routePath.replace(/\[(\.\.\.[^\]]+)\]/g, (_, raw: string) => {
    isDynamic = true;
    const pname = raw.slice(3);
    paramNames.push(pname);
    return "*" + pname;
  });

  routePath = routePath.replace(/\[([^\]]+)\]/g, (_, pname: string) => {
    isDynamic = true;
    paramNames.push(pname);
    return ":" + pname;
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

export const parseModule = (filePath: string, relPath: string, content: string): ModuleInfo => {
  const parsed = parseModuleAST(content);
  return {
    path: filePath,
    relPath,
    content,
    imports: parsed.imports,
    exports: parsed.exports,
    symbols: parsed.symbols,
    hasDefaultExport: parsed.hasDefaultExport,
    schemaExport: parsed.schemaExport ? "schema" : undefined,
    configExport: parsed.configExport ? "config" : undefined,
    callGraph: new Map(),
    dataFlow: new Map(),
  };
};

// Phase Orchestrator — Functional composition
export const runDiscovery = (opts: CompilerOptions, logger: Logger): DiscoveryResult =>
  logger.time("discovery", () => {
    const files = scanDirectory(opts.routesDir);
    const modules = files.map(f => {
      const abs = join(opts.routesDir, f);
      const content = safeReadFile(abs);
      return parseModule(abs, f, content);
    }).filter(m => m.content.length > 0); // Skip unreadable files

    logger.info(`Discovered ${files.length} files, ${modules.length} modules`, {
      routesDir: opts.routesDir,
    });
    return { files, modules };
  });