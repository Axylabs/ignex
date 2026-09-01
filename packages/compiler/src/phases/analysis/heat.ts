/**
 * @fileoverview Analysis: profile-guided route heat (`hot-routes.json`).
 *
 * `ignex dev` builds capture per-route request counts (see
 * `../codegen/heat.ts`) into `<outDir>/hot-routes.json`. The analysis phase
 * merges those measured frequencies into `hotnessScore`, so the inline-budget
 * priority and dedup-leader choice reflect ACTUAL dev traffic instead of the
 * static fan-in heuristic alone.
 *
 * Contribution is log-scaled (`min(10, floor(log2(count+1)))`) so absolute
 * session volume cannot swamp the static score — only relative frequency
 * matters. A missing, stale, or malformed file degrades silently to zero
 * contribution (static heuristics remain).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CompilerOptions } from "../../types";

/** Log-scaled heat contribution for a measured request count. */
export const heatContribution = (count: number | undefined): number =>
  count !== undefined && Number.isFinite(count) && count > 0
    ? Math.min(10, Math.floor(Math.log2(count + 1)))
    : 0;

/**
 * Load the dev-session heat map (`"METHOD path"` → request count). Returns an
 * empty map when the file is absent or unreadable; entries with invalid keys
 * or non-positive/non-finite counts are dropped.
 */
export const loadRouteHeat = (
  opts: Pick<CompilerOptions, "outDir">,
): ReadonlyMap<string, number> => {
  const out = new Map<string, number>();
  if (!opts.outDir) return out;

  const file = join(opts.outDir, "hot-routes.json");
  if (!existsSync(file)) return out;

  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      version?: number;
      routes?: Record<string, unknown>;
    };
    if (parsed?.version !== 1 || typeof parsed.routes !== "object" || parsed.routes === null) {
      return out;
    }
    for (const [key, value] of Object.entries(parsed.routes)) {
      if (typeof value !== "number") continue;
      if (!Number.isFinite(value) || value <= 0) continue;
      out.set(key, value);
    }
  } catch {
    // Malformed file — degrade to static heuristics.
  }
  return out;
};
