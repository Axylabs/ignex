/**
 * @fileoverview Request-frame codec — packs the per-request inputs (query
 * substring, Cookie header, body bytes) into the section-tagged wire the Rust
 * stack consumes, with pre-encoded hot-path variants.
 *
 * Extracted from the pre-split `route-wire.ts` (move-only); `READ`/`encode`
 * buffer helpers come from `./plan` (`dv`) and `../../util` (`encoder`).
 */

import { encoder } from "../util";
import { dv } from "./plan";

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

/**
 * Packed byte-length of a request frame from PRE-ENCODED query/cookie bytes
 * (synced from castrum's `packRouteFrame` shape — the compiled handlers' hot
 * path encodes once and then measures/packs without re-encoding or building
 * the frame object).
 */
export const packRouteFramePartsLength = (
  query: Uint8Array,
  cookie: Uint8Array,
  body: Uint8Array | null,
): number => {
  const hasBody = body != null && body.byteLength > 0 ? 1 : 0;
  return (
    4 + 4 + query.byteLength + 4 + cookie.byteLength + (hasBody ? 4 + (body?.byteLength ?? 0) : 0)
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
  packRouteFramePartsInto(out, q, c, frame.body);
};

/**
 * Write a request frame from PRE-ENCODED query/cookie bytes into `out` (must
 * be ≥ {@link packRouteFramePartsLength}) — no re-encode, no frame object.
 * Body bytes pass through zero-copy.
 */
export const packRouteFramePartsInto = (
  out: Uint8Array,
  query: Uint8Array,
  cookie: Uint8Array,
  body: Uint8Array | null,
): void => {
  const b = body;
  const hasBody = b != null && b.byteLength > 0 ? 1 : 0;

  const view = dv(out);
  let pos = 0;
  view.setUint32(pos, hasBody, true);
  pos += 4;
  view.setUint32(pos, query.byteLength, true);
  pos += 4;
  out.set(query, pos);
  pos += query.byteLength;
  view.setUint32(pos, cookie.byteLength, true);
  pos += 4;
  out.set(cookie, pos);
  pos += cookie.byteLength;
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
