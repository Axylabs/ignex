/**
 * @fileoverview Header plan + packing for the direct C-ABI ingress pipeline —
 * which request headers the route needs, the per-header size guards, and the
 * packed `[u16 count]{[u16 klen][key][u32 vlen][value]}` block written into a
 * pooled scratch buffer, with the origin-only cached fast paths.
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import { withScratch } from "../scratch";
import { encoder } from "../util";
import { METHOD_KIND } from "./constants";

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
export function packSelectedHeaders(
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
