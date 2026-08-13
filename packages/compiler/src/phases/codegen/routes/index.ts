/**
 * @fileoverview `phases/codegen/routes` — per-route handler emission.
 *
 * Modules: generate (the `generateRouteCode` orchestrator), ws, constant,
 * context, validate, reply, handler, cache. The folder layout is an internal
 * implementation detail; consumers import `../codegen/routes` (resolves to
 * this barrel).
 */

export { generateRouteCode } from "./generate";
