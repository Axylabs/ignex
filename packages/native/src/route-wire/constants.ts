/**
 * @fileoverview Per-route native stack — binary wire format (constants).
 *
 * The contract between `@ignex/native` and the Rust addon
 * (`rust/ingress/native_route.rs`),
 * in the same section-tagged `[u32 len][bytes]` little-endian style as the
 * existing packed format (`packed.ts`). Three layouts:
 *
 *   1. ROUTE DESCRIPTOR (compile-time) — what the per-route Rust instance
 *      pre-bakes: parse flags, limits, and the draft-07 JSON schemas it must
 *      compile (fast_schema / jsonschema) ONCE at construction. Built by the
 *      compiler from `RouteIR.decisions` (schemaDoc + usage), consumed by
 *      `castrum_route_compile`.
 *   2. REQUEST FRAME (per-request) — query substring + Cookie header + body
 *      bytes packed ONCE per request. This is the single "data conversion
 *      before Rust" cost — it replaces the per-op `toBytes`/buffer copies of
 *      the scalar wrappers (queryPairs/cookiePairs/validators), which is
 *      exactly where native measured x0.28 / x0.105 / x0.007 (selection.json).
 *   3. RESULT (per-request) — ok/error + per-part validation verdicts +
 *      packed query/cookie pairs (decoded once with `readPairsPacked`).
 *
 * Never change one side alone: bump {@link ROUTE_DESC_VERSION} so a descriptor
 * compiled by an older compiler is rejected by a newer addon (and vice versa)
 * instead of being misparsed.
 *
 * Extracted from the pre-split `route-wire.ts` (move-only) — this file owns
 * the wire vocabulary (magic/version/tags/flags) shared by the descriptor,
 * frame and result codecs.
 */

/** Magic that identifies a route descriptor (`"ROUT"`). */
export const ROUTE_DESC_MAGIC = 0x524f5554;
/**
 * Wire version — bump on ANY layout change (descriptor, frame, or result).
 *
 * v2 → v3 (Phase 2): the per-route stack now runs `validateBody` /
 * `requireJsonBody` on the raw body bytes (bytes-in / verdict-out) and reports
 * a failure via `errorCode` in the result header (0 = ok, 400 = body is not
 * valid JSON, 422 = body failed its schema). The frame gains the body section
 * `[u32 blen][body]` and the descriptor now carries the body schema.
 */
export const ROUTE_DESC_VERSION = 3;

/** The validate-able route parts (mirrors compiler `PART_KINDS` + response). */
export type RoutePartKind = "params" | "query" | "cookie" | "body" | "headers" | "response";

/** Wire part→tag map (shared by the descriptor codec). */
export const PART_TAG: Record<RoutePartKind, number> = {
  params: 0,
  query: 1,
  cookie: 2,
  body: 3,
  headers: 4,
  response: 5,
};
/** Wire tag→part map (shared by the descriptor codec). */
export const TAG_PART: readonly RoutePartKind[] = [
  "params",
  "query",
  "cookie",
  "body",
  "headers",
  "response",
];

/** Frame flag: the body section is present (bit 0 of the frame flags word). */
export const ROUTE_FRAME_FLAG_HAS_BODY = 1 << 0;

/** Result flag: the route stack succeeded (else errorCode is meaningful). */
export const ROUTE_RESULT_FLAG_OK = 1 << 0;
/** Result flag: the body parsed as well-formed JSON. */
export const ROUTE_RESULT_FLAG_BODY_VALID_JSON = 1 << 1;
/** Result flag: the parsed query satisfied its schema (when one exists). */
export const ROUTE_RESULT_FLAG_QUERY_VALID = 1 << 2;
/** Result flag: the parsed cookies satisfied their schema (when one exists). */
export const ROUTE_RESULT_FLAG_COOKIE_VALID = 1 << 3;
/** Result flag: the body satisfied its schema (when one exists). */
export const ROUTE_RESULT_FLAG_BODY_VALID = 1 << 4;
/** Result flag: the matched params satisfied their schema (when one exists). */
export const ROUTE_RESULT_FLAG_PARAMS_VALID = 1 << 5;
/** Result flag: the headers satisfied their schema (when one exists). */
export const ROUTE_RESULT_FLAG_HEADERS_VALID = 1 << 6;
