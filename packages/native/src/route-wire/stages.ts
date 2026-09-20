/**
 * @fileoverview Pipeline stages of the per-route native stack — the stage
 * vocabulary the compiled JS prelude emits and the descriptor codec projects.
 *
 * Extracted from the pre-split `route-wire.ts` (move-only).
 */

/**
 * A single stage in a route's pre-baked pipeline. The compiler emits ONLY the
 * stages the route needs (features on/off), in the exact order the compiled JS
 * prelude runs them — so Rust follows the same fixed function stack per route.
 *
 * Stage tags MUST match `STAGE_*` in castrum `rust/ingress/native_route.rs`.
 */
export type NativeRouteStage =
  | "parseQuery"
  | "parseCookies"
  | "validateQuery"
  | "validateCookies"
  | "validateBody"
  | "requireJsonBody";

/** Stage tag bytes (wire values; mirror castrum `rust/ingress/native_route.rs`). */
export const ROUTE_STAGE_TAG: Record<NativeRouteStage, number> = {
  parseQuery: 0,
  parseCookies: 1,
  validateQuery: 2,
  validateCookies: 3,
  validateBody: 4,
  requireJsonBody: 5,
};
const TAG_STAGE: readonly (NativeRouteStage | undefined)[] = [
  "parseQuery",
  "parseCookies",
  "validateQuery",
  "validateCookies",
  "validateBody",
  "requireJsonBody",
];

/** Wire tag→stage map (shared by the descriptor codec). */
export { TAG_STAGE };
