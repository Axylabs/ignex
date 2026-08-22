/**
 * Types for the read-side document-drift validator (`validateDoc`). Pure type
 * declarations — the detection logic lives in `./validate.ts`,
 * `./field-validators.ts` (per-kind rules), and `./helpers.ts`.
 */

/**
 * Read-path drift policy: how the ORM reacts to a document that doesn't match
 * its declared schema when it is fetched from the DB (cache-miss).
 *
 *   - `'off'`    — do not check (pre-drift-detection behavior).
 *   - `'report'` — log a warning with field-level detail, return as-is.
 *   - `'throw'`  — throw `DomainError SCHEMA_DRIFT` with the offending fields.
 */
export type DriftMode = "off" | "report" | "throw";

export type DriftIssueCode = "missing" | "type" | "unknown_key" | "constraint" | "enum";

/** A single schema/drift violation on a stored document. */
export interface DriftIssue {
  /** Dot-path to the offending field (array indexes as `[n]`), e.g. `profile.address.city`. */
  path: string;
  code: DriftIssueCode;
  /** Human-readable expectation, e.g. `string(minLength 3)`, `ObjectId`, `enum[...]`. */
  expected: string;
  message: string;
}
