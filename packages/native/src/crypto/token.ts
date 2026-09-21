/**
 * @fileoverview Random token generation — hex-encoded CSPRNG tokens (native →
 * webcrypto fallback). No imports beyond the runtime probe + hex encoding.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); re-exported by
 * `./index`.
 */

import { nativeFor } from "../runtime";
import { hexEncode, toStr } from "../util";

// ── Random tokens / passwords ───────────────────────────────────

const MAX_TOKEN_BYTES = 16 * 1024 * 1024;

/** Generate a hex-encoded CSPRNG token of `byteLen` bytes (2× the length in characters). */
export const randomToken = (byteLen: number): string => {
  // Native returns the token as hex-string (cstring) or hex-string bytes.
  const nv = nativeFor("randomToken");
  if (nv) return toStr(nv.randomToken(byteLen));
  return randomTokenFallback(byteLen);
};

/** Hex of `byteLen` CSPRNG bytes (2× the length in characters). */
export const randomTokenFallback = (byteLen: number): string => {
  const len = Math.max(0, Math.floor(byteLen));
  if (len > MAX_TOKEN_BYTES) {
    throw new Error(`random_token: byte_len ${byteLen} exceeds max ${MAX_TOKEN_BYTES}`);
  }
  // `crypto.getRandomValues` (webcrypto) is the fast, portable CSPRNG — native
  // in Bun and Node — and beats the Rust addon for token-sized output.
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return hexEncode(bytes);
};
