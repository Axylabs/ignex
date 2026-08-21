/**
 * @fileoverview Direct C-ABI ingress pipeline (`createNativeIngress`).
 *
 * Drives castrum's full native ingress pipeline (CORS / rate-limit / IP-trust /
 * body-guard / JSON-schema) through the `castrum_ingress_*` C-ABI surface —
 * NO castrum TS-layer round trip. Transfer is minimal-overhead by construction:
 *   - `url`/`ip` cross as `cstring` ARGs — the engine transcodes the JS strings
 *     in-engine (ZERO JS-side `encoder.encode`, no frame assembly for URL/IP);
 *   - the packed headers block (or the empty block when the route needs none)
 *     is written into a pooled scratch buffer;
 *   - the 48-byte output header is decoded with cached DataView reads (no
 *     TextDecoder, no intermediate objects);
 *   - the opaque `inner` handle comes from the napi `Ingress` instance, which is
 *     held alive for the handle's lifetime (same contract as the route/instance
 *     surfaces).
 *
 * The output normalizes into the SAME {@link NativePreflightOutcome} shape as
 * `createNativePipeline` (pipeline.ts), so `nativePreflight` can prefer this
 * path with zero plugin changes. Returns `null`-friendly factories (never
 * throw) when the addon lacks the ingress symbols.
 */

import { getFfiIngress } from "./ffi";
import { getNative } from "./loader";
import type { NativeRouteResponder } from "./native-handler";
import { nativeRouteHandler } from "./native-handler";
import type {
  NativeIngressOptions,
  NativePreflightOutcome,
  NativePreflightResult,
} from "./pipeline";
import { createNativeRoute } from "./route";
import type { NativeRoutePlan } from "./route-wire";
import { withScratch } from "./scratch";
import { encoder } from "./util";

// ── Output wire layout (rust/ingress/output.rs — the canonical source) ──
//
// The ingress output offsets, flags, header-variant bits and error codes are
// OWNED by Rust (`rust/ingress/output.rs`) and projected to JS at runtime via
// the C-ABI `castrum_ingress_layout` 38×u32 blob (bound in ffi.ts) — so a
// layout change in Rust needs NO TS edit. `DEFAULT_LAYOUT` below is the parity
// safety net used only when the blob cannot be read; the values are pinned to
// output.rs by `scripts/verify-native-ffi.ts` / the ingress parity tests.

/** Slot order of the 38×u32 ingress layout blob (`rust/ffi.rs` IngressLayout). */
const SLOT = {
  OUT_VERDICT: 0,
  OUT_ERROR_CODE: 1,
  OUT_STATUS: 2,
  OUT_FLAGS: 3,
  OUT_RATE_LIMIT: 4,
  OUT_RATE_REMAINING: 5,
  OUT_RATE_RESET: 6,
  OUT_RETRY_AFTER: 7,
  OUT_COOKIES_JSON_LEN: 8,
  OUT_QUERY_JSON_LEN: 9,
  OUT_HEADER_VARIANT: 10,
  OUT_BODY_JSON_LEN: 11,
  OUT_DATA_START: 12,
  FLAG_RATE_LIMITED: 19,
  HV_CORS_SIMPLE: 24,
  HV_CORS_PREFLIGHT: 25,
  HV_RATE_ACTIVE: 26,
  HV_RATE_LIMITED: 27,
  ERR_CORS_PREFLIGHT: 30,
  ERR_RATE_LIMITED: 31,
  ERR_BODY_TOO_LARGE: 32,
  ERR_INVALID_JSON: 33,
  ERR_SCHEMA_VALIDATION: 34,
  ERR_BAD_REQUEST: 35,
  ERR_REQUEST_TOO_LARGE: 36,
  ERR_INTERNAL: 37,
} as const;

/** The Rust-owned ingress wire layout (offsets / bits / codes). */
export interface IngressLayout {
  readonly outVerdict: number; // u8
  readonly outErrorCode: number; // u8
  readonly outStatus: number; // u16 LE
  readonly outFlags: number; // u32
  readonly outRateLimit: number; // u32
  readonly outRateRemaining: number; // u32
  readonly outRateReset: number; // u64 ms
  readonly outRetryAfter: number; // u64 ms
  readonly outCookiesJsonLen: number; // u32
  readonly outQueryJsonLen: number; // u32
  readonly outHeaderVariant: number; // u8
  readonly outBodyJsonLen: number; // u32
  readonly outDataStart: number;
  readonly flagRateLimited: number;
  readonly hvCorsSimple: number;
  readonly hvCorsPreflight: number;
  readonly hvRateActive: number;
  readonly hvRateLimited: number;
  readonly errCorsPreflight: number;
  readonly errRateLimited: number;
  readonly errBodyTooLarge: number;
  readonly errInvalidJson: number;
  readonly errSchemaValidation: number;
  readonly errBadRequest: number;
  readonly errRequestTooLarge: number;
  readonly errInternal: number;
}

/** Parity safety net — identical to `rust/ingress/output.rs` (see module doc). */
const DEFAULT_LAYOUT: IngressLayout = {
  outVerdict: 0,
  outErrorCode: 1,
  outStatus: 2,
  outFlags: 4,
  outRateLimit: 8,
  outRateRemaining: 12,
  outRateReset: 16,
  outRetryAfter: 24,
  outCookiesJsonLen: 32,
  outQueryJsonLen: 36,
  outHeaderVariant: 40,
  outBodyJsonLen: 44,
  outDataStart: 48,
  flagRateLimited: 1 << 6,
  hvCorsSimple: 2,
  hvCorsPreflight: 4,
  hvRateActive: 8,
  hvRateLimited: 16,
  errCorsPreflight: 1,
  errRateLimited: 2,
  errBodyTooLarge: 3,
  errInvalidJson: 4,
  errSchemaValidation: 5,
  errBadRequest: 6,
  errRequestTooLarge: 7,
  errInternal: 8,
};

/** Word count of the `castrum_ingress_layout` blob (38 × u32 LE). */
const LAYOUT_BLOB_WORDS = 38;

let cachedLayout: IngressLayout | null = null;
/** Resolve the ingress layout from Rust once (cached; never throws). */
function resolveLayout(): IngressLayout {
  if (cachedLayout) return cachedLayout;
  let L = DEFAULT_LAYOUT;
  const ffiIng = getFfiIngress();
  if (ffiIng) {
    try {
      const buf = new Uint8Array(LAYOUT_BLOB_WORDS * 4);
      if (ffiIng.ingressLayout(buf) >= LAYOUT_BLOB_WORDS * 4) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const get = (slot: number): number => view.getUint32(slot * 4, true);
        L = {
          outVerdict: get(SLOT.OUT_VERDICT),
          outErrorCode: get(SLOT.OUT_ERROR_CODE),
          outStatus: get(SLOT.OUT_STATUS),
          outFlags: get(SLOT.OUT_FLAGS),
          outRateLimit: get(SLOT.OUT_RATE_LIMIT),
          outRateRemaining: get(SLOT.OUT_RATE_REMAINING),
          outRateReset: get(SLOT.OUT_RATE_RESET),
          outRetryAfter: get(SLOT.OUT_RETRY_AFTER),
          outCookiesJsonLen: get(SLOT.OUT_COOKIES_JSON_LEN),
          outQueryJsonLen: get(SLOT.OUT_QUERY_JSON_LEN),
          outHeaderVariant: get(SLOT.OUT_HEADER_VARIANT),
          outBodyJsonLen: get(SLOT.OUT_BODY_JSON_LEN),
          outDataStart: get(SLOT.OUT_DATA_START),
          flagRateLimited: get(SLOT.FLAG_RATE_LIMITED),
          hvCorsSimple: get(SLOT.HV_CORS_SIMPLE),
          hvCorsPreflight: get(SLOT.HV_CORS_PREFLIGHT),
          hvRateActive: get(SLOT.HV_RATE_ACTIVE),
          hvRateLimited: get(SLOT.HV_RATE_LIMITED),
          errCorsPreflight: get(SLOT.ERR_CORS_PREFLIGHT),
          errRateLimited: get(SLOT.ERR_RATE_LIMITED),
          errBodyTooLarge: get(SLOT.ERR_BODY_TOO_LARGE),
          errInvalidJson: get(SLOT.ERR_INVALID_JSON),
          errSchemaValidation: get(SLOT.ERR_SCHEMA_VALIDATION),
          errBadRequest: get(SLOT.ERR_BAD_REQUEST),
          errRequestTooLarge: get(SLOT.ERR_REQUEST_TOO_LARGE),
          errInternal: get(SLOT.ERR_INTERNAL),
        };
      }
    } catch {
      // The blob read failed — keep the parity defaults (identical numbers).
    }
  }
  cachedLayout = L;
  return L;
}

/** HTTP method → native ingress method-kind enum (shared.ts). */
const METHOD_KIND: Record<string, number> = {
  GET: 0,
  HEAD: 1,
  POST: 2,
  PUT: 3,
  PATCH: 4,
  DELETE: 5,
  OPTIONS: 6,
};
const METHOD_KIND_UNKNOWN = 7;

/** Default ingress output-buffer size (bytes) — pooled per instance. */
const DEFAULT_OUTPUT_BUFFER_SIZE = 131_072;
/** Absolute cap on the ingress output buffer (matches castrum). */
const MAX_OUTPUT_BUFFER_SIZE = 64 * 1024 * 1024;

// ── Pre-encoded error bodies (benchmark wire, castrum-parity) ──
const staticErrorBody = (code: string, message: string): Uint8Array =>
  encoder.encode(`{"ok":false,"error":{"code":"${code}","message":"${message}"}}`);

/** Terminal tables keyed by the Rust-owned error codes (built once from the layout). */
interface ResolvedIngress {
  readonly L: IngressLayout;
  readonly errorStatus: Readonly<Record<number, number>>;
  readonly errorBodies: Readonly<Record<number, Uint8Array>>;
}

let cachedResolved: ResolvedIngress | null = null;
/** Resolve the layout + error tables once (cached; never throws). */
function resolveIngress(): ResolvedIngress {
  if (cachedResolved) return cachedResolved;
  const L = resolveLayout();
  cachedResolved = {
    L,
    errorStatus: {
      [L.errCorsPreflight]: 403,
      [L.errRateLimited]: 429,
      [L.errBodyTooLarge]: 413,
      [L.errInvalidJson]: 400,
      [L.errSchemaValidation]: 422,
      [L.errBadRequest]: 400,
      [L.errRequestTooLarge]: 413,
      [L.errInternal]: 500,
    },
    errorBodies: {
      [L.errCorsPreflight]: staticErrorBody(
        "cors_preflight_not_allowed",
        "CORS preflight not allowed",
      ),
      [L.errRateLimited]: staticErrorBody("rate_limited", "Too Many Requests"),
      [L.errBodyTooLarge]: staticErrorBody("body_too_large", "Request body is too large"),
      [L.errInvalidJson]: staticErrorBody("invalid_json", "Invalid JSON body"),
      [L.errSchemaValidation]: staticErrorBody(
        "schema_validation_failed",
        "Request body failed schema validation",
      ),
      [L.errBadRequest]: staticErrorBody("bad_request", "Bad request"),
      [L.errRequestTooLarge]: staticErrorBody("request_too_large", "Request too large"),
      [L.errInternal]: staticErrorBody("internal_error", "Internal server error"),
    },
  };
  return cachedResolved;
}

const RATE_LIMIT_BODY_PREFIX = encoder.encode(
  '{"ok":false,"error":{"code":"rate_limited","message":"Too Many Requests","retry_after_ms":',
);
const RATE_LIMIT_BODY_SUFFIX = encoder.encode("}}");

/** Rate-limited error body with `retry_after_ms` inlined. */
function rateLimitedBody(retryAfterMs: number): Uint8Array {
  const digits = encoder.encode(String(Math.max(0, Math.floor(retryAfterMs))));
  const out = new Uint8Array(
    RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength + RATE_LIMIT_BODY_SUFFIX.byteLength,
  );
  out.set(RATE_LIMIT_BODY_PREFIX, 0);
  out.set(digits, RATE_LIMIT_BODY_PREFIX.byteLength);
  out.set(RATE_LIMIT_BODY_SUFFIX, RATE_LIMIT_BODY_PREFIX.byteLength + digits.byteLength);
  return out;
}

/** Fallback status per native error code — owned by `resolveIngress()` (keyed by the Rust error codes). */

/** Which request headers to extract into the packed block (shared.ts parity). */
export interface IngressHeaderPlan {
  cookie: boolean;
  cors: boolean;
  proxy: boolean;
  proto: boolean;
}

/** Build the header plan from ingress options (mirrors castrum's buildHeaderPlan). */
export function buildIngressHeaderPlan(options: {
  parseCookies?: boolean;
  cors?: unknown;
  trustProxy?: boolean;
  trustedProxies?: { enabled?: boolean };
  https?: boolean;
}): IngressHeaderPlan {
  const trust = options.trustProxy === true || options.trustedProxies?.enabled === true;
  return {
    cookie: options.parseCookies === true,
    cors: options.cors != null,
    proxy: trust,
    proto: trust && options.https === undefined,
  };
}

/** Shared `[u16 count 0]` empty headers block (never mutated — safe to reuse). */
const EMPTY_HEADERS = new Uint8Array([0, 0]);

// ── Per-header size guards (mirror castrum's scratch.ts policy) ────────────
// A header value larger than the bound below is dropped BEFORE packing rather
// than forwarded: the native ingress core caps the packed block at
// `max_headers_bytes` (65536), so an oversized cookie/xff/origin would
// otherwise push the block past the cap and 500. Same single policy as
// castrum's `gatherRawHeadersPacked` / `forEachSelectedHeader` (synced).
/** Upper bound for the `cookie` header value. */
const MAX_COOKIE_HEADER_BYTES = 8192;
/** Upper bound for small single-value headers (origin, ACRM, ACRH, ...). */
const MAX_SMALL_HEADER_BYTES = 2048;
/** Upper bound for the `x-forwarded-for` header value. */
const MAX_XFF_HEADER_BYTES = 8192;

// ── Pre-encoded header names (no per-request `encoder.encode`) ─────────────
const HDR_COOKIE = encoder.encode("cookie");
const HDR_ORIGIN = encoder.encode("origin");
const HDR_ACRM = encoder.encode("access-control-request-method");
const HDR_ACRH = encoder.encode("access-control-request-headers");
const HDR_XFF = encoder.encode("x-forwarded-for");
const HDR_XRI = encoder.encode("x-real-ip");
const HDR_XFP = encoder.encode("x-forwarded-proto");

/**
 * Cached packed blocks for the CORS-only case, keyed by origin string.
 * Bounded (FIFO eviction) — a multi-origin deployment never grows it
 * unboundedly, and a single-origin deployment hits a stable single entry.
 * Module state is per-thread in Bun workers, so no cross-thread aliasing.
 */
const ORIGIN_BLOCK_CACHE = new Map<string, Uint8Array>();
const ORIGIN_CACHE_MAX = 8;

/**
 * Return (building and caching on first use) the packed header block for a
 * CORS-only plan whose only selected header is `origin`.
 *
 * The block is byte-identical to what the general path would produce
 * (`[u16 1][u16 klen]['origin'][u32 vlen][value]`), built once and copied out
 * of the scratch arena into a STABLE allocation — never aliased to the pool,
 * so it stays valid across subsequent packs and FFI calls.
 */
function cachedOriginBlock(origin: string): Uint8Array {
  const hit = ORIGIN_BLOCK_CACHE.get(origin);
  if (hit !== undefined) return hit;

  const block = withScratch(2 + 2 + HDR_ORIGIN.byteLength + 4 + origin.length * 3, (scratch) => {
    const view = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
    view.setUint16(0, 1, true);
    view.setUint16(2, HDR_ORIGIN.byteLength, true);
    scratch.set(HDR_ORIGIN, 4);
    const lenPos = 4 + HDR_ORIGIN.byteLength;
    const written = encoder.encodeInto(
      origin,
      scratch.subarray(lenPos + 4, scratch.length),
    ).written;
    view.setUint32(lenPos, written, true);
    return scratch.slice(0, lenPos + 4 + written); // slice = stable copy
  });

  if (ORIGIN_BLOCK_CACHE.size >= ORIGIN_CACHE_MAX) {
    const firstKey = ORIGIN_BLOCK_CACHE.keys().next().value;
    if (firstKey !== undefined) ORIGIN_BLOCK_CACHE.delete(firstKey);
  }
  ORIGIN_BLOCK_CACHE.set(origin, block);
  return block;
}

/** CORS-preflight headers (ACRM/ACRH) with the shared small-header guard. */
function collectCorsPreflight(h: Headers): Array<[Uint8Array, string]> {
  const out: Array<[Uint8Array, string]> = [];
  const acrm = h.get("access-control-request-method");
  if (acrm !== null && acrm.length <= MAX_SMALL_HEADER_BYTES) out.push([HDR_ACRM, acrm]);
  const acrh = h.get("access-control-request-headers");
  if (acrh !== null && acrh.length <= MAX_SMALL_HEADER_BYTES) out.push([HDR_ACRH, acrh]);
  return out;
}

/**
 * Collect the headers selected by `plan` as `[pre-encoded name, value]` pairs,
 * applying the shared per-header size guards (an oversized value is dropped).
 * The general (slow-but-rare) path: preflight, proxy/proto plans, or a plan
 * with a cookie header actually present.
 */
function collectSelectedHeaders(
  req: Request,
  plan: IngressHeaderPlan,
  methodKind: number,
  preFetchedCookie: string | null | undefined,
): Array<[Uint8Array, string]> {
  const entries: Array<[Uint8Array, string]> = [];
  const h = req.headers;
  if (plan.cookie) {
    const v = preFetchedCookie !== undefined ? preFetchedCookie : h.get("cookie");
    if (v !== null && v.length <= MAX_COOKIE_HEADER_BYTES) entries.push([HDR_COOKIE, v]);
  }
  if (plan.cors) {
    const origin = h.get("origin");
    if (origin !== null && origin.length <= MAX_SMALL_HEADER_BYTES) {
      entries.push([HDR_ORIGIN, origin]);
    }
    if (methodKind === METHOD_KIND.OPTIONS) {
      entries.push(...collectCorsPreflight(h));
    }
  }
  if (plan.proxy) {
    const xff = h.get("x-forwarded-for");
    if (xff !== null && xff.length <= MAX_XFF_HEADER_BYTES) entries.push([HDR_XFF, xff]);
    const xri = h.get("x-real-ip");
    if (xri !== null && xri.length <= MAX_SMALL_HEADER_BYTES) entries.push([HDR_XRI, xri]);
  }
  if (plan.proto) {
    const xfp = h.get("x-forwarded-proto");
    if (xfp !== null && xfp.length <= MAX_SMALL_HEADER_BYTES) entries.push([HDR_XFP, xfp]);
  }
  return entries;
}

/**
 * Pack the collected `[name, value]` entries into the native header block
 * `[u16 count]{[u16 klen][key][u32 vlen][value]}` in a pooled scratch buffer.
 */
function packHeaderEntries(entries: Array<[Uint8Array, string]>): Uint8Array {
  if (entries.length === 0) return EMPTY_HEADERS;

  let bound = 2; // [u16 count]
  for (const [name, value] of entries) bound += 2 + name.byteLength + 4 + value.length * 3;
  return withScratch(bound, (scratch) => {
    const view = new DataView(scratch.buffer, scratch.byteOffset, scratch.byteLength);
    let pos = 2;
    for (const [name, value] of entries) {
      view.setUint16(pos, name.byteLength, true);
      scratch.set(name, pos + 2);
      pos += 2 + name.byteLength;
      const lenPos = pos;
      pos += 4;
      const written = encoder.encodeInto(value, scratch.subarray(pos, scratch.length)).written;
      view.setUint32(lenPos, written, true);
      pos += written;
    }
    view.setUint16(0, entries.length, true);
    return scratch.subarray(0, pos);
  });
}

/**
 * Pack the headers selected by `plan` into the native `[u16 count]{[u16 klen]
 * [key][u32 vlen][value]}` block, written into a pooled scratch buffer (no
 * per-request alloc; valid only for the duration of the FFI call). A route
 * needing no headers yields the 2-byte empty block (count 0). The scratch is
 * sized to the EXACT UTF-8 bound (≤3× per UTF-16 code unit) so no selected
 * header is ever dropped.
 *
 * Fast paths (synced from castrum's `gatherRawHeadersPacked`):
 *  - A plan selecting NO headers short-circuits to the shared empty block.
 *  - A CORS-ONLY plan on a non-preflight request (the dominant minimal-route
 *    case, e.g. the benchmark server) produces a block that depends ONLY on
 *    the `Origin` header value — cached keyed by origin, so the per-request
 *    UTF-8 encode of the origin (the largest single JS packing cost) and the
 *    scratch write are skipped entirely.
 *  - A cookie+cors plan on a request carrying NO cookie header still produces
 *    the origin-only block (byte-identical to the general path), so it reuses
 *    the cached block; when a cookie IS present the already-fetched value is
 *    handed down to the general path (no second `req.headers.get('cookie')`).
 */
function packSelectedHeaders(
  req: Request,
  plan: IngressHeaderPlan,
  methodKind: number,
): Uint8Array {
  if (!plan.cookie && !plan.cors && !plan.proxy && !plan.proto) {
    return EMPTY_HEADERS;
  }

  const nonPreflight = methodKind !== METHOD_KIND.OPTIONS;

  // CORS-only fast path (preflight is excluded — it also packs ACRM/ACRH and
  // must take the general path). The MAX_SMALL_HEADER_BYTES guard mirrors the
  // general path (an oversized origin is dropped → empty block, not cached).
  if (plan.cors && !plan.cookie && !plan.proxy && !plan.proto && nonPreflight) {
    const origin = req.headers.get("origin");
    if (origin === null || origin.length > MAX_SMALL_HEADER_BYTES) {
      return EMPTY_HEADERS;
    }
    return cachedOriginBlock(origin);
  }

  // cookie+cors fast path: when the request carries NO cookie header (the
  // dominant API/bench case), the packed block is still origin-only, so the
  // (typically constant) origin can reuse the cached block instead of being
  // UTF-8 re-encoded + re-packed on every request. When a cookie IS present,
  // fall through to the general path but hand the already-fetched value down
  // (no second `req.headers.get('cookie')`).
  let preFetchedCookie: string | null | undefined;
  if (plan.cors && plan.cookie && !plan.proxy && !plan.proto && nonPreflight) {
    preFetchedCookie = req.headers.get("cookie");
    if (preFetchedCookie === null) {
      const origin = req.headers.get("origin");
      if (origin === null || origin.length > MAX_SMALL_HEADER_BYTES) {
        return EMPTY_HEADERS;
      }
      return cachedOriginBlock(origin);
    }
  }

  return packHeaderEntries(collectSelectedHeaders(req, plan, methodKind, preFetchedCookie));
}

/** Decoded 48-byte ingress output header (primitives only — no escaping buffers). */
interface IngressVerdict {
  ok: boolean;
  errorCode: number;
  status: number;
  flags: number;
  rateLimit: number;
  rateRemaining: number;
  rateResetMs: number;
  retryAfterMs: number;
  headerVariant: number;
  cookiesJsonLen: number;
  queryJsonLen: number;
  bodyJsonLen: number;
}

/**
 * Decode the output header from `buf[0..48]` into `target` with cached
 * DataView reads. Writes into a caller-provided (pooled) target so the hot
 * path allocates ZERO objects per request — the decode result is consumed
 * synchronously before the next request reuses the same target.
 */
function decodeVerdict(
  buf: Uint8Array,
  view: DataView,
  target: IngressVerdict,
  L: IngressLayout,
): IngressVerdict {
  target.ok = buf[L.outVerdict] === 0;
  target.errorCode = buf[L.outErrorCode] ?? 0;
  target.status = view.getUint16(L.outStatus, true);
  target.flags = view.getUint32(L.outFlags, true);
  target.rateLimit = view.getUint32(L.outRateLimit, true);
  target.rateRemaining = view.getUint32(L.outRateRemaining, true);
  // i64 LE read as two u32 halves (lo + hi * 2^32) instead of `getBigUint64`
  // — avoids the per-read BigInt boxing (~10ns per read on the hot path,
  // synced from castrum's `decode/result-base.ts`). Bit-identical to
  // `Number(getBigUint64(..))` for the unsigned interpretation and exact for
  // epoch-ms (< 2^53).
  const resetLo = view.getUint32(L.outRateReset, true);
  const resetHi = view.getUint32(L.outRateReset + 4, true);
  target.rateResetMs = resetLo + resetHi * 4294967296;
  const retryLo = view.getUint32(L.outRetryAfter, true);
  const retryHi = view.getUint32(L.outRetryAfter + 4, true);
  target.retryAfterMs = retryLo + retryHi * 4294967296;
  target.headerVariant = buf[L.outHeaderVariant] ?? 0;
  target.cookiesJsonLen = view.getUint32(L.outCookiesJsonLen, true);
  target.queryJsonLen = view.getUint32(L.outQueryJsonLen, true);
  target.bodyJsonLen = view.getUint32(L.outBodyJsonLen, true);
  return target;
}

/** Whole-seconds ceil (rate-limit headers are whole seconds). */
const secondsFromMs = (ms: number): number => Math.ceil(ms / 1000);

/**
 * Decode a captured path segment, keeping the raw (undecoded) text when the
 * percent-encoding is malformed — a client URIError must not become a 500.
 */
const safeDecodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** Runtime hooks: pre-baked security headers applied to terminal responses. */
export interface NativeIngressRuntime {
  /** Ordered `[name, value][]` security headers baked into terminal responses. */
  securityHeaders?: ReadonlyArray<[string, string]>;
  /** Output buffer size (bytes). Default 131072. */
  outputBufferSize?: number;
}

/** A direct C-ABI ingress pre-flight instance. */
export interface NativeIngress {
  /**
   * Run the pipeline once for a request. Returns the outcome SYNCHRONOUSLY
   * (the C-ABI core is sync) — no per-request Promise/microtask — typed as
   * `Promise | value` so callers can `await` if they prefer. On any native
   * failure resolves to a non-terminal outcome (never breaks the flow).
   */
  preprocess(
    request: Request,
    ip?: string,
  ): NativePreflightOutcome | Promise<NativePreflightOutcome>;
  /**
   * True when the config needs the client IP (rate-limit / trust-proxy).
   * Callers should pass `undefined` when false to skip the `requestIP` lookup.
   */
  readonly needsIp: boolean;
  /** Release the underlying napi instance + handle. */
  destroy(): void;
}

const U32_MAX = 4_294_967_295; // castrum's "rate limiting disabled" sentinel

/**
 * Create a direct C-ABI ingress pre-flight instance (or `null` when the addon
 * lacks the ingress symbols). Each request runs ONE `castrum_ingress_handle_*`
 * call with `cstring` url/ip + the packed headers block, and the 48-byte
 * verdict is decoded with zero TextDecoder/alloc. Terminal decisions build a
 * response with the pre-baked security headers + rate-limit/CORS headers.
 */
export const createNativeIngress = (
  options: NativeIngressOptions = {},
  runtime: NativeIngressRuntime = {},
): NativeIngress | null => {
  const ffiIng = getFfiIngress();
  if (!ffiIng) return null;
  const L = resolveLayout();
  const addon = getNative();
  if (!addon || typeof (addon as { Ingress?: unknown }).Ingress !== "function") return null;

  let instance: { ingressInnerPtr(): bigint };
  try {
    // Cast ONLY the constructor accessor — `new addon(...)` would construct the
    // module (not a constructor); `new IngressCtor(...)` constructs the napi class.
    const IngressCtor = (
      addon as unknown as { Ingress: new (o: unknown) => { ingressInnerPtr(): bigint } }
    ).Ingress;
    instance = new IngressCtor(options);
  } catch {
    return null;
  }
  const inner = Number(instance.ingressInnerPtr());
  if (!inner) return null;

  const plan = buildIngressHeaderPlan(options);
  const trustEnabled = options.trustProxy === true || options.trustedProxies?.enabled === true;
  const rateEnabled = options.rateLimit != null;
  const securityEntries: ReadonlyArray<[string, string]> = Object.freeze([
    ...(runtime.securityHeaders ?? []),
  ]);
  const outputBufferSize = Math.min(
    MAX_OUTPUT_BUFFER_SIZE,
    Math.max(L.outDataStart, Math.floor(runtime.outputBufferSize ?? DEFAULT_OUTPUT_BUFFER_SIZE)),
  );
  // Per-instance reusable output buffer + cached DataView (no per-request alloc;
  // decoded synchronously before the next request reuses it — same discipline
  // as castrum's BufferPool happy path).
  let output = new Uint8Array(outputBufferSize);
  let outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);

  const corsOpts = options.cors;

  const growOutput = (needed: number): void => {
    if (needed <= output.length) return;
    let cap = output.length * 2;
    while (cap < needed) cap *= 2;
    output = new Uint8Array(Math.min(cap, MAX_OUTPUT_BUFFER_SIZE));
    outputView = new DataView(output.buffer, output.byteOffset, output.byteLength);
  };

  // Pooled per-request objects — consumed synchronously by the caller before
  // the next request reuses them (same discipline as the pooled output buffer
  // and the `withScratch` arena). Eliminates 2 allocations per request off the
  // hot path. The OK `body` is a shared immutable empty view (never mutated).
  const verdict: IngressVerdict = {
    ok: false,
    errorCode: 0,
    status: 0,
    flags: 0,
    rateLimit: 0,
    rateRemaining: 0,
    rateResetMs: 0,
    retryAfterMs: 0,
    headerVariant: 0,
    cookiesJsonLen: 0,
    queryJsonLen: 0,
    bodyJsonLen: 0,
  };
  const okResult: NativePreflightResult = {
    ok: true,
    status: 200,
    terminal: false,
    rateLimited: false,
    requestId: "",
    body: EMPTY_BYTES,
  };

  const runOnce = (request: Request, ip: string | undefined): NativePreflightOutcome => {
    const methodKind = METHOD_KIND[request.method] ?? METHOD_KIND_UNKNOWN;
    const headers = packSelectedHeaders(request, plan, methodKind);
    // ip: the plugin passes `ctx.ip`; default to the empty string (cstring "").
    const ipStr = ip ?? "";
    growOutput(L.outDataStart);
    const w = ffiIng.ingressHandleComponents(
      inner,
      methodKind,
      request.url,
      ipStr,
      EMPTY_RID,
      headers,
      null,
      output,
    );
    if (w === 0) {
      // Native failure → non-terminal (the request flow is never broken).
      return { terminal: false, response: null, result: null };
    }
    if (w > output.length) {
      growOutput(w);
      const w2 = ffiIng.ingressHandleComponents(
        inner,
        methodKind,
        request.url,
        ipStr,
        EMPTY_RID,
        headers,
        null,
        output,
      );
      if (w2 === 0 || w2 > output.length) {
        return { terminal: false, response: null, result: null };
      }
    }
    const v = decodeVerdict(output, outputView, verdict, L);
    if (v.ok) {
      // Reuse the pooled OK result (consumed synchronously; no per-request
      // object allocation). `ok`/`terminal`/`requestId`/`body` never change;
      // the two mutable fields are written through a pooled mutable slot (the
      // readonly surface is for external callers — callers must not retain the
      // result past the synchronous consumption).
      const slot = okResult as { status: number; rateLimited: boolean };
      slot.status = v.status || 200;
      slot.rateLimited = (v.flags & L.flagRateLimited) !== 0;
      return { terminal: false, response: null, result: okResult };
    }
    // Terminal: build the response (status + baked headers + error body).
    return {
      terminal: true,
      response: buildTerminalResponse(request, v, securityEntries, corsOpts, L),
      result: null,
    };
  };

  return {
    preprocess(request, ip) {
      // Synchronous: the C-ABI core does not await anything, so returning the
      // value directly (not via an `async` fn) avoids a per-request Promise
      // allocation + microtask on every request.
      return runOnce(request, ip);
    },
    needsIp: rateEnabled || trustEnabled,
    destroy() {
      // The napi instance is GC'd when the closure drops; nothing else to free.
      instance = undefined as unknown as { ingressInnerPtr(): bigint };
    },
  };
};

const EMPTY_RID = new Uint8Array(0);
/** Shared immutable empty body view for pooled OK results (never mutated). */
const EMPTY_BYTES = new Uint8Array(0);

/** Build the terminal response from a decoded verdict (status + headers + body). */
function buildTerminalResponse(
  request: Request,
  v: IngressVerdict,
  securityEntries: ReadonlyArray<[string, string]>,
  cors: NativeIngressOptions["cors"],
  L: IngressLayout,
): Response {
  const { errorStatus, errorBodies } = resolveIngress();
  const hv = v.headerVariant;
  const headers: Array<[string, string]> = [
    ...securityEntries,
    ...buildRateLimitHeaders(v, hv, L),
    ...buildCorsHeaders(request, hv, cors, L),
  ];
  const status = v.status || errorStatus[v.errorCode] || 400;
  const body =
    v.errorCode === L.errRateLimited
      ? rateLimitedBody(v.retryAfterMs || 0)
      : (errorBodies[v.errorCode] ?? errorBodies[L.errInternal]);
  return new Response(body as unknown as BodyInit, { status, headers });
}

/** Rate-limit response headers (limit/remaining/reset + retry-after when limited). */
function buildRateLimitHeaders(
  v: IngressVerdict,
  hv: number,
  L: IngressLayout,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const rateActive = (hv & L.hvRateActive) !== 0;
  const rateLimited = (hv & L.hvRateLimited) !== 0 || v.errorCode === L.errRateLimited;
  if (rateActive) {
    if (v.rateLimit !== U32_MAX) headers.push(["ratelimit-limit", String(v.rateLimit)]);
    headers.push(["ratelimit-remaining", String(v.rateRemaining)]);
    headers.push(["ratelimit-reset", String(secondsFromMs(v.rateResetMs))]);
  }
  if (rateLimited) {
    headers.push(["retry-after", String(secondsFromMs(v.retryAfterMs || 0))]);
  }
  return headers;
}

/** CORS response headers for simple + preflight outcomes (empty when CORS inactive). */
function buildCorsHeaders(
  request: Request,
  hv: number,
  cors: NativeIngressOptions["cors"],
  L: IngressLayout,
): Array<[string, string]> {
  const headers: Array<[string, string]> = [];
  const corsSimple = (hv & L.hvCorsSimple) !== 0;
  const corsPreflight = (hv & L.hvCorsPreflight) !== 0;
  if ((corsSimple || corsPreflight) && cors) {
    const origin = request.headers.get("origin");
    if (origin != null) {
      headers.push(["access-control-allow-origin", origin]);
      if (cors.allowCredentials) headers.push(["access-control-allow-credentials", "true"]);
    }
    if (corsPreflight) {
      if (corsAllowMethodsValue(cors))
        headers.push(["access-control-allow-methods", corsAllowMethodsValue(cors)]);
      if (corsAllowHeadersValue(cors))
        headers.push(["access-control-allow-headers", corsAllowHeadersValue(cors)]);
      if (corsMaxAgeValue(cors)) headers.push(["access-control-max-age", corsMaxAgeValue(cors)]);
    }
    if (corsExposeHeadersValue(cors))
      headers.push(["access-control-expose-headers", corsExposeHeadersValue(cors)]);
  }
  return headers;
}

const corsAllowMethodsValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowMethods?.join(", ") ?? "";
const corsAllowHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.allowHeaders?.join(", ") ?? "";
const corsExposeHeadersValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.exposeHeaders?.join(", ") ?? "";
const corsMaxAgeValue = (c: NonNullable<NativeIngressOptions["cors"]>): string =>
  c.maxAge != null ? String(c.maxAge) : "";

// ── Per-route native ingress router (`createNativeIngressRouter`) ──
// The "one super solution" over the global pipeline: each route in the table
// compiles a DEDICATED native pipeline pruned to EXACTLY that route's stages
// (castrum's `createIngressRouter` model). A route that needs no CORS/rate/
// cookies/query gathers ZERO headers and runs a near-empty pipeline — the
// per-route pruning win. All routes share the same C-ABI wire + a shared
// fallback responder for the non-terminal (app-owned) path.

/** Per-route spec for {@link createNativeIngressRouter}. */
export interface NativeIngressRouterRoute {
  /** Per-route ingress options — compiled into a DEDICATED native pipeline. */
  options?: NativeIngressOptions;
  /**
   * A LEAN native-stack responder route (synced from castrum's router `native`
   * kind): the route-wire v3 per-route stack (`createNativeRoute` over
   * `castrum_route_*`) runs ONLY the stages in `plan`
   * (parseQuery/parseCookies/requireJsonBody/validateBody) in ONE native
   * call — no CORS/rate-limit/security/IP/metadata envelope. On a verdict
   * failure the route rejects (400 non-JSON / 422 schema); on success the
   * responder builds the 2xx from the decoded snapshot. Wired for `methods`
   * (default `['GET']`). When set, `options` for this route is ignored.
   */
  native?: {
    /** The route-wire v3 plan (parse/validate stages + limits). */
    plan: NativeRoutePlan;
    /** The JS 2xx builder (receives the decoded query/cookies/body snapshot). */
    handler: NativeRouteResponder;
    /** HTTP methods to wire (default `['GET']`). */
    methods?: ReadonlyArray<string>;
    /** Read the body for `requireJsonBody`/`validateBody` (default false). */
    readBody?: boolean;
  };
}

/** Options for {@link createNativeIngressRouter}. */
export interface CreateNativeIngressRouterOptions {
  /** Route table: path → per-route ingress options. */
  routes: Record<string, NativeIngressRouterRoute>;
  /** Shared runtime (security headers / output buffer) applied to every route. */
  runtime?: NativeIngressRuntime;
  /**
   * Responder for non-terminal (OK) requests — the app's own handler. The
   * router serves the pipeline's terminal decision (CORS/429/413/400/422)
   * and delegates the OK path to this. Default: a JSON `{"ok":true}` 200.
   */
  fallback?: (req: Request) => Response | Promise<Response>;
  /** Pre-warm every compiled route's pipeline at construction. Default: false. */
  warmOnCreate?: boolean;
}

/** A compiled per-route native ingress router. */
export interface NativeIngressRouter {
  /** Per-path compiled pre-flight instances (null when a path could not compile). */
  routeHandlers: Record<string, NativeIngress | null>;
  /** Bun.serve-compatible route table (each method → the pre-flight handler). */
  routes: Record<string, Record<string, (req: Request) => Response | Promise<Response>>>;
  /** Path matcher (`:param` / `*` dynamic routes), most-specific-first. */
  match(pathname: string): { path: string; params: Record<string, string> } | undefined;
  /** Pre-warm every compiled route (JIT the pipeline + FFI call). */
  prewarm(): Promise<void>;
}

const ROUTER_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/** Compile a `:param` / `*` route path into a RegExp + param names. */
function compileRoutePath(path: string): { re: RegExp; params: string[]; staticSegments: number } {
  const params: string[] = [];
  const src = path
    .split("/")
    .map((seg) => {
      if (seg === "*") return "(?:/(.*))?";
      if (seg.startsWith(":")) {
        params.push(seg.slice(1));
        return "([^/]+)";
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("/");
  return { re: new RegExp(`^${src}\\/?$`), params, staticSegments: path.split("/").length };
}

/**
 * Compile a route table into per-route native ingress pipelines. Each route
 * with `options` compiles its OWN `createNativeIngress` — a dedicated
 * `IngressInner` pruned to that route's stages + per-route header plan (routes
 * needing nothing gather ZERO headers). `routes` is Bun.serve-compatible;
 * `match`/`prewarm` mirror castrum's `createIngressRouter`.
 */
export const createNativeIngressRouter = (
  options: CreateNativeIngressRouterOptions,
): NativeIngressRouter | null => {
  const runtime = options.runtime ?? {};
  const fallback =
    options.fallback ?? ((_req: Request): Response => new Response('{"ok":true}', { status: 200 }));

  const compiled: Record<string, NativeIngress | null> = {};
  const routeTable: Record<
    string,
    Record<string, (req: Request) => Response | Promise<Response>>
  > = {};

  for (const [path, spec] of Object.entries(options.routes)) {
    // LEAN native-stack responder route: the route-wire v3 stack runs ONLY the
    // plan's stages (no full IngressInner, no CORS/rate-limit/security). The
    // compiled route is injected into the pure responder factory (the compile
    // touches the dlopen layer here).
    if (spec.native) {
      const nativeRoute = createNativeRoute(spec.native.plan);
      if (nativeRoute === null) continue; // addon lacks the route surface → skip
      const handler = nativeRouteHandler(
        nativeRoute,
        spec.native.handler,
        spec.native.readBody !== undefined ? { readBody: spec.native.readBody } : {},
      );
      const methods: Record<string, (req: Request) => Response | Promise<Response>> = {};
      for (const m of spec.native.methods ?? ["GET"]) methods[m] = handler;
      routeTable[path] = methods;
      compiled[path] = null;
      continue;
    }

    const ingress = createNativeIngress(spec.options ?? {}, runtime);
    compiled[path] = ingress;
    if (!ingress) continue;
    // Per-route pre-flight handler: serve the pipeline's terminal decision,
    // else delegate the OK path to the app's fallback responder.
    const handler = async (req: Request): Promise<Response> => {
      // Sync fast path: the C-ABI core returns the outcome directly, so branch
      // on Promise instead of awaiting unconditionally — avoids a per-request
      // await suspension + microtask (the async fn still yields to Bun.serve).
      const outcome = ingress.preprocess(req);
      const { terminal, response } = outcome instanceof Promise ? await outcome : outcome;
      return terminal && response ? response : fallback(req);
    };
    const methods: Record<string, (req: Request) => Response | Promise<Response>> = {};
    for (const m of ROUTER_METHODS) methods[m] = handler;
    routeTable[path] = methods;
  }

  // Most-specific-first matcher (static segments desc, then fewer params).
  const patterns = Object.entries(compiled)
    .filter(([, ing]) => ing !== null)
    .map(([path]) => ({ path, ...compileRoutePath(path) }))
    .sort((a, b) => b.staticSegments - a.staticSegments || a.params.length - b.params.length);

  const match = (
    pathname: string,
  ): { path: string; params: Record<string, string> } | undefined => {
    for (const p of patterns) {
      const m = p.re.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      for (let i = 0; i < p.params.length; i++)
        params[p.params[i] as string] = safeDecodeParam(m[i + 1] ?? "");
      return { path: p.path, params };
    }
    return undefined;
  };

  const prewarm = async (): Promise<void> => {
    const probe = new Request("http://localhost:0/prewarm", { method: "GET" });
    for (const ing of Object.values(compiled)) {
      if (ing) await ing.preprocess(probe);
    }
  };

  if (options.warmOnCreate) void prewarm();

  return { routeHandlers: compiled, routes: routeTable, match, prewarm };
};
