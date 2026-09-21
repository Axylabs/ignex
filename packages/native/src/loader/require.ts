/**
 * @fileoverview Addon surface guards + Node-API loading — `isNativeSurface`
 * validates a module exposes the expected function surface, `requireAddon`
 * loads a `.node` binary via require (Node-API modules must not be ESM
 * `import`ed), and `reportLoadFailure` routes the one-time failure to the
 * telemetry sink.
 *
 * Extracted from the pre-split `loader.ts` (move-only).
 */

import { createRequire } from "node:module";
import { reportDegradation } from "../telemetry";
import type { NativeAddon } from "./types";

/** True when a module exposes the expected native function surface. */
export const isNativeSurface = (mod: unknown): mod is NativeAddon => {
  const m = mod as Record<string, unknown>;
  return (
    typeof m === "object" &&
    m !== null &&
    typeof m.fnv1a64 === "function" &&
    typeof m.crc32 === "function" &&
    typeof m.jwtSign === "function"
  );
};

/** Load a Node-API `.node` binary via require (required for napi modules). */
export const requireAddon = (nodePath: string): unknown => {
  const require = createRequire(import.meta.url);
  const mod = require(nodePath) as { default?: unknown };
  return mod.default ?? mod;
};

/** Normalize an entry module into the flat native surface. */
export const normalize = (mod: unknown): unknown =>
  (mod as { default?: unknown }).default ?? (mod as { rust?: unknown }).rust ?? mod;

/**
 * One-time load-failure report. ALWAYS routed through the telemetry sink
 * (previously debug-gated — a broken addon install degraded every op to JS
 * with zero signal in production); `IGNEX_NATIVE=debug` additionally logs the
 * raw error detail.
 */
let reportedLoadFailure = false;
export const reportLoadFailure = (err: unknown): void => {
  if (reportedLoadFailure) return;
  reportedLoadFailure = true;
  reportDegradation(
    "surface-missing",
    "addon.load",
    `castrum addon failed to load — all ops pinned to their pure-TS fallbacks${
      process.env.IGNEX_NATIVE === "debug"
        ? `: ${err instanceof Error ? err.message : String(err)}`
        : ""
    }`,
  );
  if (process.env.IGNEX_NATIVE === "debug") {
    console.info("[ignex-native] failed to load addon:", err);
  }
};
