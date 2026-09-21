/**
 * @fileoverview CSRF tokens — `<64-hex(random)>.<64-hex(HMAC-SHA256(secret,
 * rnd_hex))>` generation + constant-time verification, native-accelerated with
 * byte-compatible pure-TS fallbacks.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); the digest comes from
 * the shared `../util` helpers (not `./hmac`), re-exported by `./index`.
 */

import { nativeFor } from "../runtime";
import { ctEqual, fromBytes, hexDecode, hexEncode, hmacSha256Bytes, toBytes, toStr } from "../util";

// ── CSRF ────────────────────────────────────────────────────────

/** Generate a CSRF token (`<64-hex(random)>.<64-hex(sig)>`). */
export const csrfToken = (secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfToken");
  if (nv) return toStr(nv.csrfToken(s));
  return csrfTokenFallback(s);
};

/** `<64-hex(random)>.<64-hex(HMAC-SHA256(secret, rnd_hex))>`. */
export const csrfTokenFallback = (secret: Uint8Array): string => {
  // `crypto.getRandomValues` (webcrypto) is the fast, portable CSPRNG — native
  // in Bun (~87x vs `node:crypto` randomBytes for small buffers — see
  // docs/bun-internals.md) and available in Node too.
  const rnd = new Uint8Array(32);
  crypto.getRandomValues(rnd);
  const rndHex = hexEncode(rnd);
  const sig = hexEncode(hmacSha256Bytes(secret, toBytes(rndHex)));
  return `${rndHex}.${sig}`;
};

/** Constant-time verify of a CSRF token. */
export const csrfVerify = (token: string | Uint8Array, secret: string | Uint8Array): boolean => {
  const s = toBytes(secret);
  const nv = nativeFor("csrfVerify");
  if (nv) return nv.csrfVerify(toBytes(token), s);
  return csrfVerifyFallback(fromBytes(toBytes(token)), s);
};

/** Pure-TS fallback for {@link csrfVerify} (identical behavior). */
export const csrfVerifyFallback = (token: string, secret: Uint8Array): boolean => {
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const rndHex = token.slice(0, dot);
  const sigHex = token.slice(dot + 1);
  if (rndHex.length !== 64 || sigHex.length !== 64) return false;
  const sig = hexDecode(sigHex);
  if (!sig) return false;
  const expected = hmacSha256Bytes(secret, toBytes(rndHex));
  return ctEqual(expected, sig);
};
