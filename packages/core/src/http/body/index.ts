/**
 * @fileoverview `http/body` — lazy body parsing.
 *
 * Modules: errors, types, limits, form-data, size, conversion, lazy-body.
 * The folder layout is an internal implementation detail; consumers import
 * `../http/body` (resolves to this barrel).
 */

export { BodyParseError } from "./errors";
export { createLazyBody } from "./lazy-body";
export { readBodyBounded } from "./size";
export type { LazyBody, LazyBodyOptions } from "./types";
