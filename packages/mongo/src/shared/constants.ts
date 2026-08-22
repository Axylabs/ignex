/** Default cap for list/pagination limits (mirrors sdk-db). */
export const DEFAULT_MAX_LIMIT = 1000;

/** Default limit applied to `findMany` when none is provided. */
export const DEFAULT_FIND_LIMIT = 100;

/**
 * Hard cap for a single `insertMany` / `bulkWrite` / `bulkUpsert` call (the
 * driver splits at 100k; anything above is almost certainly an unbounded caller
 * array). Above this the ORM throws `BadRequest` instead of spiking memory.
 */
export const MAX_BATCH_OPS = 100_000;
