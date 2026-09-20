/**
 * @fileoverview Decoding of the 48-byte ingress output header — cached DataView
 * reads into a pooled verdict object (zero per-request allocs), plus the small
 * shared decode helpers (`secondsFromMs`, `safeDecodeParam`).
 *
 * Extracted from the pre-split `ingress.ts` (move-only).
 */
import type { IngressLayout } from "./layout";

/** Decoded 48-byte ingress output header (primitives only — no escaping buffers). */
export interface IngressVerdict {
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
export function decodeVerdict(
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
export const secondsFromMs = (ms: number): number => Math.ceil(ms / 1000);

/**
 * Decode a captured path segment, keeping the raw (undecoded) text when the
 * percent-encoding is malformed — a client URIError must not become a 500.
 */
export const safeDecodeParam = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
