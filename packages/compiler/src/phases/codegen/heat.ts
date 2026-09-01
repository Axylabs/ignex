/**
 * @fileoverview Codegen: dev-only heat capture (`heatCapture`).
 *
 * When enabled (`ignex dev`), the generated server counts requests per route
 * into a module-level null-prototype object and flushes the counters to
 * `<outDir>/hot-routes.json` on an unref'd interval. The next build's analysis
 * phase merges those measured frequencies into `hotnessScore`, turning the
 * static fan-in heuristic into profile-guided priority for the inline budget
 * and dedup-leader choice.
 *
 * The per-request cost is one property lookup + increment on a hidden-class-
 * free object, emitted ONLY in dev builds — production artifacts contain no
 * counter at all (the option is part of the build fingerprint, so dev and
 * prod caches never collide).
 */

import type { RouteIR } from "../../types";

/** Flush cadence for `<outDir>/hot-routes.json` (ms). */
export const HEAT_FLUSH_INTERVAL_MS = 10_000;

/** Current schema version of the heat file. Unknown versions are ignored. */
export const HEAT_FILE_VERSION = 1;

/**
 * The emitted heat-capture module: counter object + interval flush. Written
 * to `<outDir>/hot-routes.json` relative to the artifact itself
 * (`import.meta.dir`), mirroring how dev certs resolve their directory.
 */
export const emitHeatModule =
  (): string => `const __HEAT_PATH = (import.meta.dir || process.cwd()) + "/hot-routes.json";
const __heat = Object.create(null);
const __heatFlush = () => Bun.write(__HEAT_PATH, JSON.stringify({ version: ${HEAT_FILE_VERSION}, updatedAt: new Date().toISOString(), routes: __heat }));
setInterval(() => { __heatFlush().catch(() => {}); }, ${HEAT_FLUSH_INTERVAL_MS}).unref?.();`;

/**
 * The per-route increment statement (`""` when heat capture is off). Emitted
 * as the first statement of the route's table-bound handler so every served
 * request — cached wrappers and inlined handlers included — counts exactly
 * once under its static `"METHOD path"` identity.
 */
export const heatCountStmt = (route: RouteIR, enabled: boolean): string =>
  enabled
    ? `__heat[${JSON.stringify(`${route.source.method} ${route.source.path}`)}] = (__heat[${JSON.stringify(
        `${route.source.method} ${route.source.path}`,
      )}] ?? 0) + 1;`
    : "";
