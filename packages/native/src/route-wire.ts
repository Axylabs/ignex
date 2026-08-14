/**
 * @fileoverview Per-route native stack — binary wire format.
 *
 * The contract between `@ignex/native` and the Rust addon (`rust/route.rs`),
 * in the same section-tagged `[u32 len][bytes]` little-endian style as the
 * existing packed formats (`packed.ts` / `tasks.ts`). Three layouts:
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
 */

import { ffiBuf, ffiString, ffiU32 } from "./ffi-read";
import { encoder } from "./util";

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

const PART_TAG: Record<RoutePartKind, number> = {
  params: 0,
  query: 1,
  cookie: 2,
  body: 3,
  headers: 4,
  response: 5,
};
const TAG_PART: readonly RoutePartKind[] = [
  "params",
  "query",
  "cookie",
  "body",
  "headers",
  "response",
];

// ── Pipeline stages (features the per-route instance can run) ────
/**
 * A single stage in a route's pre-baked pipeline. The compiler emits ONLY the
 * stages the route needs (features on/off), in the exact order the compiled JS
 * prelude runs them — so Rust follows the same fixed function stack per route.
 *
 * Stage tags MUST match `STAGE_*` in castrum `rust/route.rs`.
 */
export type NativeRouteStage =
  | "parseQuery"
  | "parseCookies"
  | "validateQuery"
  | "validateCookies"
  | "validateBody"
  | "requireJsonBody";

/** Stage tag bytes (wire values; mirror castrum `rust/route.rs`). */
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

/**
 * Everything a route's native stack pre-bakes: the exact ordered `pipeline`
 * (which features run, and in what order — the compiler enables only what the
 * route needs), the draft-07 JSON schemas for validated parts (compiled once
 * at construction, so there is no per-request schema work), and the limits.
 */
export interface NativeRoutePlan {
  /** The exact ordered pipeline the instance follows (features on, in order). */
  readonly pipeline: readonly NativeRouteStage[];
  /** Draft-07 JSON schema bytes per validated part (query/cookie/body/…). */
  readonly schemas: Readonly<Partial<Record<RoutePartKind, Uint8Array>>>;
  readonly maxBodyBytes: number;
  readonly maxQueryBytes: number;
  readonly maxCookieBytes: number;
  readonly maxPairs: number;
}

/** True when the plan's pipeline includes `stage`. */
export const planHasStage = (plan: NativeRoutePlan, stage: NativeRouteStage): boolean =>
  plan.pipeline.includes(stage);

const dv = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

/**
 * Encode a route plan into the descriptor wire. The compiler emits this once
 * per eligible route; Rust compiles it into a pre-baked instance.
 *
 * Wire: `[magic][version][maxBody][maxQuery][maxCookie][maxPairs]
 * [stageCount]{[u8 stage]}[schemaCount]{[u8 part][u32 len][schema]}`.
 */
export const encodeRouteDescriptor = (plan: NativeRoutePlan): Uint8Array => {
  const kinds = Object.keys(plan.schemas) as RoutePartKind[];
  // header: magic, version, 4 limits, stageCount, schemaCount
  let total = 4 + 4 + 4 * 4 + 4 + 4;
  total += plan.pipeline.length; // 1 byte per stage
  for (const k of kinds) total += 1 + 4 + ((plan.schemas[k]?.byteLength ?? 0) as number);

  const out = new Uint8Array(total);
  const view = dv(out);
  let pos = 0;
  view.setUint32(pos, ROUTE_DESC_MAGIC, true);
  pos += 4;
  view.setUint32(pos, ROUTE_DESC_VERSION, true);
  pos += 4;
  view.setUint32(pos, plan.maxBodyBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxQueryBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxCookieBytes, true);
  pos += 4;
  view.setUint32(pos, plan.maxPairs, true);
  pos += 4;
  view.setUint32(pos, plan.pipeline.length, true);
  pos += 4;
  for (const stage of plan.pipeline) {
    out[pos] = ROUTE_STAGE_TAG[stage];
    pos += 1;
  }
  view.setUint32(pos, kinds.length, true);
  pos += 4;
  for (const k of kinds) {
    const schema = plan.schemas[k] as Uint8Array;
    out[pos] = PART_TAG[k];
    pos += 1;
    view.setUint32(pos, schema.byteLength, true);
    pos += 4;
    out.set(schema, pos);
    pos += schema.byteLength;
  }
  return out;
};

/** The descriptor wire as decoded (validated magic/version) by {@link decodeRouteDescriptor}. */
export interface DecodedRouteDescriptor extends NativeRoutePlan {
  readonly version: number;
}

/**
 * Decode + validate a route descriptor wire. Throws on a bad magic or a
 * version the current codec cannot parse — a mismatched compiler/addon is a
 * hard error, never a silent misparse.
 */
export const decodeRouteDescriptor = (buf: Uint8Array): DecodedRouteDescriptor => {
  const view = dv(buf);
  const magic = view.getUint32(0, true);
  if (magic !== ROUTE_DESC_MAGIC) {
    throw new Error(`route descriptor: bad magic 0x${magic.toString(16)}`);
  }
  const version = view.getUint32(4, true);
  if (version !== ROUTE_DESC_VERSION) {
    throw new Error(
      `route descriptor: unsupported version ${version} (this build supports ${ROUTE_DESC_VERSION})`,
    );
  }
  let pos = 8;
  const maxBodyBytes = view.getUint32(pos, true);
  pos += 4;
  const maxQueryBytes = view.getUint32(pos, true);
  pos += 4;
  const maxCookieBytes = view.getUint32(pos, true);
  pos += 4;
  const maxPairs = view.getUint32(pos, true);
  pos += 4;

  const stageCount = view.getUint32(pos, true);
  pos += 4;
  const pipeline: NativeRouteStage[] = [];
  for (let i = 0; i < stageCount; i++) {
    const tag = buf[pos] as number;
    pos += 1;
    const stage = TAG_STAGE[tag];
    if (stage === undefined) throw new Error(`route descriptor: unknown stage tag ${tag}`);
    pipeline.push(stage);
  }

  const schemaCount = view.getUint32(pos, true);
  pos += 4;
  const schemas: Partial<Record<RoutePartKind, Uint8Array>> = {};
  for (let i = 0; i < schemaCount; i++) {
    const tag = buf[pos] as number;
    pos += 1;
    const kind = TAG_PART[tag];
    if (kind === undefined) throw new Error(`route descriptor: unknown part tag ${tag}`);
    const len = view.getUint32(pos, true);
    pos += 4;
    schemas[kind] = buf.subarray(pos, pos + len);
    pos += len;
  }

  return {
    version,
    pipeline,
    schemas,
    maxBodyBytes,
    maxQueryBytes,
    maxCookieBytes,
    maxPairs,
  };
};

// ── Request frame (per-request) ─────────────────────────────────
/** Frame flag: the body section is present (bit 0 of the frame flags word). */
export const ROUTE_FRAME_FLAG_HAS_BODY = 1 << 0;

/** The per-request inputs to the native stack (already sliced by the caller). */
export interface NativeRouteFrame {
  /** Query substring (the part after `?`) — empty when absent. */
  readonly query: string;
  /** Raw `Cookie` header value — empty when absent. */
  readonly cookie: string;
  /** Raw request body bytes — `null` when the route has no body. */
  readonly body: Uint8Array | null;
}

/** Packed byte-length of a request frame (size the pooled buffer exactly). */
export const packRouteFrameLength = (frame: NativeRouteFrame): number => {
  const hasBody = frame.body != null && frame.body.byteLength > 0 ? 1 : 0;
  return (
    4 +
    4 +
    Buffer.byteLength(frame.query, "utf8") +
    4 +
    Buffer.byteLength(frame.cookie, "utf8") +
    (hasBody ? 4 + (frame.body?.byteLength ?? 0) : 0)
  );
};

/** Query/cookie byte-lengths read back from a packed frame (no re-encode). */
export const readRouteFrameLengths = (packed: Uint8Array): { qLen: number; cLen: number } => {
  const view = dv(packed);
  const qLen = view.getUint32(4, true);
  const cLen = view.getUint32(4 + 4 + qLen, true);
  return { qLen, cLen };
};

/** Write a request frame into `out` (must be ≥ {@link packRouteFrameLength}). */
export const packRouteFrameInto = (out: Uint8Array, frame: NativeRouteFrame): void => {
  const q = encoder.encode(frame.query);
  const c = encoder.encode(frame.cookie);
  const b = frame.body;
  const hasBody = b != null && b.byteLength > 0 ? 1 : 0;

  const view = dv(out);
  let pos = 0;
  view.setUint32(pos, hasBody, true);
  pos += 4;
  view.setUint32(pos, q.byteLength, true);
  pos += 4;
  out.set(q, pos);
  pos += q.byteLength;
  view.setUint32(pos, c.byteLength, true);
  pos += 4;
  out.set(c, pos);
  pos += c.byteLength;
  if (hasBody) {
    view.setUint32(pos, b?.byteLength ?? 0, true);
    pos += 4;
    out.set(b ?? new Uint8Array(0), pos);
  }
};

/**
 * Pack a request frame ONCE per request. This is the single conversion cost
 * before the native call — query/cookie are UTF-8 encoded here (the one
 * `encoder.encode`), body bytes pass through zero-copy. Prefer
 * `packRouteFrameInto` + a pooled scratch buffer on the hot path.
 */
export const packRouteFrame = (frame: NativeRouteFrame): Uint8Array => {
  const out = new Uint8Array(packRouteFrameLength(frame));
  packRouteFrameInto(out, frame);
  return out;
};

// ── Result (per-request) ────────────────────────────────────────
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

/**
 * Decode the result wire into a typed {@link NativeRouteRunResult}. The
 * pair sections use the standard packed-pairs layout (`readPairsPacked`), so
 * callers can re-use the existing `pairsToObject` / grouping helpers.
 *
 * Decodes through the shared bun:ffi fast path (`ffi-read.ts`): no DataView
 * allocation, engine-native `CString` string reads; DataView/TextDecoder
 * fallback under Node. Both are byte-identical.
 */
export const readRouteResult = (buf: Uint8Array): NativeRouteRunResult => {
  const b = ffiBuf(buf);
  const flags = ffiU32(b, 0);
  const errorCode = ffiU32(b, 4);
  let pos = 8;

  const readPairs = (): Array<[string, string]> => {
    const count = ffiU32(b, pos);
    pos += 4;
    const out: Array<[string, string]> = [];
    for (let i = 0; i < count; i++) {
      const nameLen = ffiU32(b, pos);
      pos += 4;
      const name = ffiString(b, pos, nameLen);
      pos += nameLen;
      const valueLen = ffiU32(b, pos);
      pos += 4;
      const value = ffiString(b, pos, valueLen);
      pos += valueLen;
      out.push([name, value]);
    }
    return out;
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
    query: readPairs(),
    cookie: readPairs(),
  };
};
