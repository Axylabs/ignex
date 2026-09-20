/**
 * @fileoverview Public sub-barrel: the shared FP toolkit re-exported from the
 * `@ignex/core` entry (split from the barrel `src/index.ts` by section banner —
 * move-only; `export` statements verbatim).
 */

// ── FP toolkit (shared) ─────────────────────────────────────────
export {
  always,
  compose,
  err,
  identity,
  isErr,
  isOk,
  mapResult,
  ok,
  pipe,
  type Result,
  type Task,
  tryCatch,
  tryCatchOr,
  unwrapOr,
} from "@ignex/shared";
