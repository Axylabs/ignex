/**
 * Minimal functional core used by the compiler.
 *
 * Consolidated into `@ignus/shared` (src/fp.ts) so `@ignus/core`, the compiler
 * and native share one FP toolkit. This file re-exports just the symbols the
 * compiler actually uses, keeping existing imports working.
 */
export { err, ok, type Result } from "@ignus/shared";
