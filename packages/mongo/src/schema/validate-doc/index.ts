/**
 * Runtime document-drift validator.
 *
 * The ORM's schema validation is DB-level only (`$jsonSchema`) by design — this
 * module is NOT a client-side input validator. It is the *read-side*
 * counterpart: it checks documents already stored in MongoDB against the
 * declared schema so drift (documents written by older app versions, other
 * services, or the raw driver with validation bypassed) can be detected and
 * surfaced instead of silently reaching callers under a false type guarantee.
 *
 * It mirrors `toMongoSchema`'s mapping — every DSL field kind plus the
 * ORM-reserved lifecycle fields (`_id`, `__v`, `deletedAt`) and the
 * strict-by-default `additionalProperties: false` semantics — so the runtime
 * verdict matches what the server would enforce on write.
 *
 * Detection-only: it never mutates, coerces, or repairs documents.
 *
 * Layout: `./types.ts` (Drift types), `./helpers.ts` (value-level checks),
 * `./field-validators.ts` (per-kind rules as a registry), `./validate.ts`
 * (dispatch + object traversal + entry point).
 */

export type { DriftIssue, DriftIssueCode, DriftMode } from "./types.ts";
export { validateDoc } from "./validate.ts";
