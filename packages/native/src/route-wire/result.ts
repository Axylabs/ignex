/**
 * @fileoverview Result-wire codec — decodes the per-request native outcome
 * (ok/error + validation verdicts + packed pair sections) into a typed
 * {@link NativeRouteRunResult}, through the shared bun:ffi fast path.
 *
 * Extracted from the pre-split `route-wire.ts` (move-only); result flags come
 * from `./constants`.
 */

import { ffiBuf, ffiU32 } from "../ffi-read";
import { PackedWireError, readPairsSection } from "../packed";
import {
  ROUTE_RESULT_FLAG_BODY_VALID,
  ROUTE_RESULT_FLAG_BODY_VALID_JSON,
  ROUTE_RESULT_FLAG_COOKIE_VALID,
  ROUTE_RESULT_FLAG_HEADERS_VALID,
  ROUTE_RESULT_FLAG_OK,
  ROUTE_RESULT_FLAG_PARAMS_VALID,
  ROUTE_RESULT_FLAG_QUERY_VALID,
} from "./constants";

/** Typed, fully-decoded outcome of one native route run. */
export interface NativeRouteRunResult {
  readonly ok: boolean;
  /**
   * HTTP status / error code when `!ok` (0 when ok). Phase-2 body stages
   * report first-failure-wins: `400` = body was not valid JSON under
   * `requireJsonBody`, `422` = body failed its schema under `validateBody`.
   */
  readonly errorCode: number;
  readonly bodyValidJson: boolean;
  readonly queryValid: boolean;
  readonly cookieValid: boolean;
  readonly bodyValid: boolean;
  readonly paramsValid: boolean;
  readonly headersValid: boolean;
  /** Parsed query pairs (duplicates preserved, native-ordered). */
  readonly query: ReadonlyArray<[string, string]>;
  /** Parsed cookie pairs (duplicates preserved, native-ordered). */
  readonly cookie: ReadonlyArray<[string, string]>;
}

/** Which pair sections to decode from a result (match the plan's pipeline). */
export interface ReadRouteResultOptions {
  /**
   * Decode the query pair section. Present ONLY when the plan runs a
   * `parseQuery` stage — body-only routes carry no query section, so reading
   * it would walk past the result wire. Default `true`.
   */
  readonly query?: boolean;
  /**
   * Decode the cookie pair section. Present ONLY when the plan runs a
   * `parseCookies` stage. Default `true`.
   */
  readonly cookie?: boolean;
}

/**
 * Decode the result wire into a typed {@link NativeRouteRunResult}. The
 * pair sections use the standard packed-pairs layout (`readPairsPacked`), so
 * callers can re-use the existing `pairsToObject` / grouping helpers.
 *
 * A pair section is present only when the plan runs its parse stage
 * (`parseQuery` / `parseCookies`) — the Rust writer emits the header plus
 * exactly the sections its stages produced. Pass `{ query, cookie }` matching
 * the plan so a body-only route (header-only wire) decodes `[]` instead of
 * walking past the end of the buffer.
 *
 * Decodes through the shared bun:ffi fast path (`ffi-read.ts`): no DataView
 * allocation, engine-native `CString` string reads; DataView/TextDecoder
 * fallback under Node. Both are byte-identical.
 */
export const readRouteResult = (
  buf: Uint8Array,
  opts: ReadRouteResultOptions = {},
): NativeRouteRunResult => {
  // Fail-fast on a short wire (a lying addon reporting w < 8): decoding would
  // read garbage — under Bun via raw pointer reads. The route runner's catch
  // treats any throw as "native result unusable" → JS prelude.
  if (buf.byteLength < 8) {
    throw new PackedWireError("route-result", `header needs 8B, wire is ${buf.byteLength}B`);
  }
  const b = ffiBuf(buf);
  const flags = ffiU32(b, 0);
  const errorCode = ffiU32(b, 4);
  const readQuery = opts.query !== false;
  const readCookie = opts.cookie !== false;
  let pos = 8;

  const readPairs = (): Array<[string, string]> => {
    const section = readPairsSection(b, pos);
    pos = section.nextPos;
    return section.pairs;
  };

  return {
    ok: (flags & ROUTE_RESULT_FLAG_OK) !== 0,
    errorCode,
    bodyValidJson: (flags & ROUTE_RESULT_FLAG_BODY_VALID_JSON) !== 0,
    queryValid: (flags & ROUTE_RESULT_FLAG_QUERY_VALID) !== 0,
    cookieValid: (flags & ROUTE_RESULT_FLAG_COOKIE_VALID) !== 0,
    bodyValid: (flags & ROUTE_RESULT_FLAG_BODY_VALID) !== 0,
    paramsValid: (flags & ROUTE_RESULT_FLAG_PARAMS_VALID) !== 0,
    headersValid: (flags & ROUTE_RESULT_FLAG_HEADERS_VALID) !== 0,
    query: readQuery ? readPairs() : [],
    cookie: readCookie ? readPairs() : [],
  };
};
