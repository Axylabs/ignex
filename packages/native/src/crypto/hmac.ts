/**
 * @fileoverview HMAC-SHA256 — the leaf of the crypto surface: the digest
 * primitive that every signed cookie / CSRF token / HS256 JWT builds on.
 * Native → Bun.CryptoHasher → Node `crypto`, all returning the same
 * 64-lowercase-hex contract.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); re-exported by
 * `./index`. Cookie/csrf/jwt consume the raw digest via the shared `../util`
 * helpers rather than this file, so it stays the leaf.
 */

import { bunHmacSha256 } from "../bun";
import { nativeFor } from "../runtime";
import { ctEqual, encoder, hexEncode, hmacSha256Bytes, toBytes, toPlain } from "../util";

// ── HMAC-SHA256 ─────────────────────────────────────────────────

/** HMAC-SHA256 digest of `data` under `key` (64 lowercase-hex, native contract). */
export const hmacSha256 = (key: string | Uint8Array, data: string | Uint8Array): Uint8Array => {
  const k = toBytes(key);
  const d = toBytes(data);
  const nv = nativeFor("hmacSha256");
  if (nv) return toPlain(nv.hmacSha256(k, d));
  // Under Bun, `Bun.CryptoHasher` is mildly faster than Rust for scalar HMAC.
  if (bunHmacSha256) return bunHmacSha256(k, d);
  // Node pure-TS: hex-encode the raw digest so ALL backends (native / Bun /
  // Node) return the SAME 64-hex contract — sign→verify stays byte-compatible.
  return encoder.encode(hexEncode(hmacSha256Bytes(k, d)));
};

/** Constant-time verify of an HMAC-SHA256 signature. */
export const hmacSha256Verify = (
  key: string | Uint8Array,
  data: string | Uint8Array,
  sig: string | Uint8Array,
): boolean => {
  const k = toBytes(key);
  const d = toBytes(data);
  const s = toBytes(sig);
  const nv = nativeFor("hmacSha256Verify");
  if (nv) return nv.hmacSha256Verify(k, d, s);
  // Pure-TS fallback — MUST match the native contract: `hmacSha256`/the addon
  // produce/expect a 64 lowercase-hex signature, so compare the hex-encoded
  // digest (a raw 32-byte sig is rejected, exactly like native). Previously
  // this compared the raw digest, so pure-JS sign→verify was broken.
  return ctEqual(encoder.encode(hexEncode(hmacSha256Bytes(k, d))), s);
};
