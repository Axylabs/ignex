/**
 * @fileoverview Ignex Context — barrel.
 *
 * Preserves the pre-split `context.ts` import surface: the context types, the
 * `createContext` factory and the `pathnameOf`/`resolveClientIp` helpers that
 * the compiler's usage-specialized context also consumes.
 */

export { createContext } from "./api";
export { pathnameOf, resolveClientIp } from "./helpers";
export type { ContextOptions, IgnexContext, IgnexServer } from "./types";
