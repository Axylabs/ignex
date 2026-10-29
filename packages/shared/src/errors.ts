/**
 * @fileoverview Thrown-value normalisation shared by every package.
 *
 * `errorMessage` used to exist as a private copy in `@ignex/cli`,
 * `@ignex/compiler` and `@ignex/core`; this is now the single definition. It
 * deliberately stringifies non-`Error` throws rather than returning an empty
 * string — a route that throws a bare string still needs a message on the wire.
 */

/** Extract a human-readable message from an unknown thrown value. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
