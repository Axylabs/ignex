/**
 * @fileoverview Shared `TextEncoder` singleton.
 *
 * `TextEncoder` is stateless, so one instance is safe to reuse process-wide. A
 * module-level const avoids allocating a fresh encoder on every response or
 * hash — the compiler-generated server (`__encoder` in codegen) and the
 * interpreted pipeline share the same discipline. Single source of truth so
 * `finalize.ts`, `headers.ts` and the cache/ETag helpers can't drift.
 */
export const encoder = new TextEncoder();
