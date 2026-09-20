/**
 * @fileoverview Signed cookies — `value.<hex(HMAC-SHA256(secret, value))>`
 * sign/verify with native acceleration and byte-compatible pure-TS fallbacks.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); the digest comes from
 * the shared `../util` helpers (not `./hmac`), re-exported by `./index`.
 */

import { nativeFor } from "../runtime";
import { ctEqual, hexDecode, hexEncode, hmacSha256Bytes, toBytes, toStr } from "../util";

// ── Signed cookies ──────────────────────────────────────────────

/** Sign a cookie value → `value.<hex(HMAC-SHA256(secret, value))>`. */
export const signCookie = (value: string, secret: string | Uint8Array): string => {
  const s = toBytes(secret);
  const nv = nativeFor("signCookie");
  if (nv) return toStr(nv.signCookie(toBytes(value), s));
  return signCookieFallback(value, s);
};

/** `value.<lowercase-hex(HMAC-SHA256(secret, value))>`. */
export const signCookieFallback = (value: string, secret: Uint8Array): string => {
  const sig = hmacSha256Bytes(secret, toBytes(value));
  return `${value}.${hexEncode(sig)}`;
};

/** Verify a signed cookie; returns the value without its signature, or `null`. */
export const verifyCookie = (signed: string, secret: string | Uint8Array): string | null => {
  const s = toBytes(secret);
  const nv = nativeFor("verifyCookie");
  if (nv) {
    const result = nv.verifyCookie(toBytes(signed), s);
    // `!= null` (not truthy): a successful verify of an EMPTY value yields "".
    return result != null ? toStr(result) : null;
  }
  return verifyCookieFallback(signed, s);
};

/** Verify a signed cookie; returns the value without its signature. */
export const verifyCookieFallback = (signed: string, secret: Uint8Array): string | null => {
  const dot = signed.lastIndexOf(".");
  if (dot < 0) return null;
  const value = signed.slice(0, dot);
  const sigHex = signed.slice(dot + 1);
  if (sigHex.length !== 64) return null;
  const sig = hexDecode(sigHex);
  if (!sig) return null;
  const expected = hmacSha256Bytes(secret, toBytes(value));
  return ctEqual(expected, sig) ? value : null;
};
