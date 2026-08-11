/**
 * Runtime execution seam — the ONLY module that combines addon availability
 * with the selection table. Wrappers ask `useNative(op)` instead of checking
 * `getNative()` themselves, so "is native loaded" and "does native win for
 * this op" are answered in one place, from the single source of truth in
 * `./selection.ts`.
 */

import type { NativeAddon } from "./loader";
import { getNative } from "./loader";
import { type ExecutionBackend, type OpName, SELECTION } from "./selection";

/** The loaded castrum addon (or `null` when unavailable). Resolved once at import. */
export const native = getNative();

/**
 * True when the Rust addon is loaded AND the selection table binds this op to
 * `castrum`. Ops where native is measured slower bind to the JS fallback even
 * when the addon is present.
 */
export const useNative = (op: OpName): boolean =>
  native != null && SELECTION[op].impl === "castrum";

/**
 * The castrum addon narrowed for an op, or `null` when native is unavailable or
 * the selection table binds the op to the JS fallback. Use this in wrappers to
 * get a type-narrowed native handle without non-null assertions:
 *
 *   const n = nativeFor("fnv1a64");
 *   if (n) return n.fnv1a64(bytes);
 */
export const nativeFor = (op: OpName): NativeAddon | null => (useNative(op) ? native : null);

/** Which execution backend is active overall ("castrum" | "js"). */
export const backendName = (): ExecutionBackend => (native ? "castrum" : "js");
