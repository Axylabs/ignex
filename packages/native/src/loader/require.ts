/**
 * @fileoverview Native module surface guards and load-failure telemetry.
 * Binary loading itself belongs to castrum's runtime bridge.
 */

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

/** Normalize an entry module into the flat native surface. */
export const normalize = (mod: unknown): unknown =>
  (mod as { default?: unknown }).default ?? (mod as { rust?: unknown }).rust ?? mod;

/** One-time load-failure report through the native telemetry sink. */
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
