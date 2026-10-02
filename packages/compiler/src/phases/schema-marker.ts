/**
 * @fileoverview Standard-Schema detection markers.
 *
 * `isStandardSchema` / `STATUS_KEY` are the two tiny primitives shared by the
 * schema loader and the build-time converter. They live here so
 * `schema-convert` does not import `schema-loader` (which imports
 * `schema-convert` to convert) — that pair was an import cycle caught by
 * `scripts/check-layers.ts`.
 */

/** True when a value carries the Standard Schema `~standard` marker. */
export const isStandardSchema = (value: unknown): boolean => {
  return typeof value === "object" && value !== null && "~standard" in value;
};

/** A 3-digit HTTP status code — used to detect `{ "200": schema }` status maps. */
export const STATUS_KEY = /^\d{3}$/;
