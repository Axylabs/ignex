/**
 * @fileoverview Phase 1: DISCOVERY
 * Scans filesystem for route files and extracts module metadata via AST.
 * IO isolated in entry function. Pure functions do parsing.
 * Now with functional composition and error recovery.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DiagnosticCodes, type DiagnosticCollector, errorMessage } from "../diagnostics";
import { type SourceFile, SourceManager } from "../frontend";
import type { CompilerContext, CompilerOptions, DiscoveryResult } from "../types";

// File-based routing convention decoding lives in the IR lowering layer.
export { parseRouteFilename } from "../ir/lower";

// Pure Functions
/**
 * True when a filename looks like a route module (ts/js/mjs/tsx/jsx, not
 * `.d.ts`, not a `.config.*` file).
 *
 * Config files (`app.config.ts`, `server-only.config.ts`, …) are never routes
 * — a bare filename would otherwise parse as a default-GET route (e.g.
 * `app.config.ts` → GET `/app.config`) and get flagged for missing a handler
 * export. Excluding them here (and in the build cache) keeps config files
 * out of route discovery entirely.
 */
export const isRouteFile = (entry: string): boolean =>
  /\.(ts|js|mjs|tsx|jsx)$/.test(entry) &&
  !entry.endsWith(".d.ts") &&
  !/\.config\.(ts|js|mjs|tsx|jsx)$/.test(entry);

/** True when a directory should be descended into (skips hidden + node_modules). */
export const isValidDir = (entry: string): boolean =>
  !entry.startsWith(".") && entry !== "node_modules";

/**
 * Recursively scan a directory for route files (sorted, deterministic).
 *
 * IO errors are reported as warnings and skipped rather than thrown.
 *
 * @param dir - The directory to scan.
 * @param base - Base path prefix for returned relative paths.
 * @param diagnostics - Collector for scan-failure warnings.
 * @returns Relative route-file paths (POSIX separators).
 */
export const scanDirectory = (
  dir: string,
  base = "",
  diagnostics?: DiagnosticCollector,
): string[] => {
  const out: string[] = [];

  let entries: string[];
  try {
    // Sort for deterministic build output: `readdir` order is OS-dependent
    // and not stable run-to-run, which made generated route order (and thus
    // the emitted server) nondeterministic.
    entries = readdirSync(dir).sort();
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

// ── File-based routing convention ────────────────────────────────
// `parseRouteFilename` (filename → method/path/params) now lives in the IR
// lowering layer (`../ir/lower`) and is re-exported at the top of this file.

// Phase Orchestrator — Functional composition
//
// The frontend phase: scan the routes dir for source files, then read + parse
// each one exactly once through a {@link SourceManager}. The manager retains a
// {@link SourceFile} per file (AST included) that every later phase consumes —
// no phase re-reads or re-parses source.
/**
 * The frontend phase: scan the routes directory and parse every route module
 * exactly once through a `SourceManager` (retained AST for all later phases).
 *
 * @param opts - Compiler options (uses `routesDir`).
 * @param ctx - Logger + diagnostics.
 * @param sources - Optional pre-seeded source manager (e.g. persistent cache).
 * @returns The discovered files, modules, and source manager.
 */
export const runDiscovery = (
  opts: CompilerOptions,
  ctx: CompilerContext,
  sources?: SourceManager,
): DiscoveryResult =>
  ctx.logger.time("discovery", () => {
    const files = scanDirectory(opts.routesDir, "", ctx.diagnostics);
    // Reuse a caller-provided SourceManager (e.g. one seeded with the
    // persistent parse cache) so unchanged modules skip re-parsing.
    const manager = sources ?? new SourceManager();
    const modules: SourceFile[] = [];

    for (const f of files) {
      const abs = join(opts.routesDir, f);
      const mod = manager.read(abs, f, ctx.diagnostics);
      if (mod) modules.push(mod);
    }

    ctx.logger.info(`Discovered ${files.length} files, ${modules.length} modules`, {
      routesDir: opts.routesDir,
    });

    return { files, modules, sources: manager };
  });
