/**
 * @fileoverview Analysis: route graph construction.
 *
 * Builds `RouteIR`s from discovered modules: filename parsing, constant
 * response detection, handler refs, cache normalization and the graph.
 *
 * Lowering (filename + AST → {@link RouteIR}) lives in `../../ir/lower`; this
 * module orchestrates it over the discovered sources and keeps the
 * module-table helpers used by the rest of the analysis phase.
 */

import { DiagnosticCodes } from "../../diagnostics";
import { lowerRoute, parseRouteFilename } from "../../ir/lower";
import type { RouteIR } from "../../ir/route";
import type { CompilerContext, ModuleInfo } from "../../types";

/** Parse a route file's filename into its route shape (thin alias). */
const parseRouteFile = (file: string) => parseRouteFilename(file);

// ── RouteIR factory ──────────────────────────────────────────────

export const buildRouteGraph = (
  files: readonly string[],
  modules: readonly ModuleInfo[],
  ctx: CompilerContext,
): RouteIR[] => {
  const routes: RouteIR[] = [];

  // Index modules once — the previous per-file Array.find/findIndex scans
  // made graph construction O(files × modules).
  const byPath = new Map<string, { mod: ModuleInfo; idx: number }>();
  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    if (mod) byPath.set(mod.relPath, { mod, idx: i });
  }

  for (const file of files) {
    const parsed = parseRouteFile(file);
    if (!parsed) continue; // not a route file — nothing to report
    const hit = byPath.get(file);
    if (!hit) continue;
    const { mod, idx: moduleIdx } = hit;
    // A parseable route filename with NO handler export is a hard error: the
    // route would silently 404 in production (misspelled `httpGet`, missing
    // export, or an unparseable file that lowered to an empty program). Fail
    // the build with a clear, actionable diagnostic.
    if (!mod.hasHandlerExport && parsed.method !== "WS") {
      ctx.diagnostics.error({
        code: DiagnosticCodes.NoHandlerExport,
        message:
          `Route file has no handler export for "${parsed.method.toUpperCase()} ${parsed.path}". ` +
          "Expected one of:\n" +
          "  - `export default get((ctx) => ...)`\n" +
          `  - \`export const http${capitalized(parsed.method)} = get((ctx) => ...)\`\n` +
          "(WebSocket routes export `wsHandler` instead.)",
        file,
      });
      continue;
    }
    routes.push(lowerRoute(file, parsed, mod, routes.length, moduleIdx));
  }

  return routes;
};

/** `get` → `Get` (for export-name hints in diagnostics). */
const capitalized = (method: string): string =>
  method.charAt(0).toUpperCase() + method.slice(1).toLowerCase();
