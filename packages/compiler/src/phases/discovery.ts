/**
 * @fileoverview Phase 1: DISCOVERY
 * Scans filesystem for route files and extracts module metadata via AST.
 * IO isolated in entry function. Pure functions do parsing.
 * Now with functional composition and error recovery.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { DiagnosticCodes, type DiagnosticCollector, errorMessage } from "../diagnostics";
import type {
  CompilerContext,
  CompilerOptions,
  DiscoveryResult,
  HttpMethod,
  ModuleInfo,
  RouteDef,
} from "../types";
import { normalizeHttpMethod } from "../types";
import { parseModule as parseModuleAST } from "../utils/ast";

// Pure Functions
export const isRouteFile = (entry: string): boolean =>
  /\.(ts|js|mjs|tsx|jsx)$/.test(entry) && !entry.endsWith(".d.ts");

export const isValidDir = (entry: string): boolean =>
  !entry.startsWith(".") && entry !== "node_modules";

export const scanDirectory = (
  dir: string,
  base = "",
  diagnostics?: DiagnosticCollector,
): string[] => {
  const out: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    diagnostics?.warn({
      code: DiagnosticCodes.IoScanFailed,
      message: `Failed to read directory: ${errorMessage(error)}`,
      file: dir,
    });
    return out;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    const rel = join(base, entry).replace(/\\/g, "/");

    let isDir = false;
    try {
      isDir = statSync(abs).isDirectory();
    } catch {
      // Ignore entries that disappear mid-scan; skip them.
    }

    if (isDir) {
      if (isValidDir(entry)) {
        out.push(...scanDirectory(abs, rel, diagnostics));
      }
    } else if (isRouteFile(entry)) {
      out.push(rel);
    }
  }

  return out;
};

export const parseRouteFilename = (
  file: string,
): Pick<
  RouteDef,
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

export const parseModule = (
  filePath: string,
  relPath: string,
  content: string,
  diagnostics?: DiagnosticCollector,
): ModuleInfo => {
  const parsed = parseModuleAST(content, diagnostics);

  return {
    path: filePath,
    relPath,
    content,
    imports: parsed.imports,
    exports: parsed.exports,
    symbols: parsed.symbols,
    hasDefaultExport: parsed.hasDefaultExport,
    hasHandlerExport: parsed.hasHandlerExport,

    ...(parsed.handlerExportName !== undefined
      ? { handlerExportName: parsed.handlerExportName }
      : {}),
    ...(parsed.schemaExport ? { schemaExport: "schema" } : {}),
    ...(parsed.configExport ? { configExport: "config" } : {}),
  };
};

// Phase Orchestrator — Functional composition
export const runDiscovery = (opts: CompilerOptions, ctx: CompilerContext): DiscoveryResult =>
  ctx.logger.time("discovery", () => {
    const files = scanDirectory(opts.routesDir, "", ctx.diagnostics);
    const modules: ModuleInfo[] = [];

    for (const f of files) {
      const abs = join(opts.routesDir, f);

      let content: string;
      try {
        content = readFileSync(abs, "utf-8");
      } catch (error) {
        ctx.diagnostics.warn({
          code: DiagnosticCodes.IoReadFailed,
          message: `Failed to read route file: ${errorMessage(error)}`,
          file: abs,
        });
        continue;
      }

      if (!content || content.length === 0) {
        continue;
      }

      modules.push(parseModule(abs, f, content, ctx.diagnostics));
    }

    ctx.logger.info(`Discovered ${files.length} files, ${modules.length} modules`, {
      routesDir: opts.routesDir,
    });

    return { files, modules };
  });
