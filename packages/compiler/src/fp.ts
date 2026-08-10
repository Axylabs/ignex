/**
 * Minimal functional core used by the compiler.
 *
 * Consolidated into `@flux/shared` (src/fp.ts) so `@flux/core`, the compiler
 * and native share one FP toolkit. This file re-exports the shared surface to
 * keep existing imports working.
 */
export {
  always,
  compose,
  err,
  flatMapResult,
  identity,
  isErr,
  isOk,
  mapErr,
  mapResult,
  ok,
  pipe,
  type Result,
  type Task,
  taskChain,
  taskFromResult,
  taskMap,
  tryCatch,
  tryCatchAsync,
  tryCatchOr,
  unwrapOr,
  unwrapOrElse,
} from "@flux/shared";
