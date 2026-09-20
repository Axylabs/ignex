/**
 * @fileoverview AEAD encryption — AES-256-GCM (ciphertext ‖ 16-byte tag),
 * native-accelerated with a byte-compatible Node `crypto` fallback.
 *
 * Extracted from the pre-split `crypto.ts` (move-only); re-exported by
 * `./index`. The session envelope does NOT compose with these — it seals
 * via its own fused C-ABI surface in `./session`.
 */

import { createCipheriv, createDecipheriv } from "node:crypto";
import { nativeFor } from "../runtime";
import { toBytes, toPlain } from "../util";

// ── AEAD (AES-256-GCM / ChaCha20-Poly1305) ──────────────────────

/** AEAD encrypt (AES-256-GCM) → ciphertext ‖ 16-byte tag. */
export const aeadEncrypt = (
  key: string | Uint8Array,
  nonce: string | Uint8Array,
  plaintext: string | Uint8Array,
  algorithm?: string | null,
): Uint8Array => {
  const k = toBytes(key);
  const n = toBytes(nonce);
  const p = toBytes(plaintext);
  const nv = nativeFor("aeadEncrypt");
  if (nv) return toPlain(nv.aeadEncrypt(k, n, p, algorithm ?? null));
  return aeadEncryptFallback(k, n, p, algorithm ?? null);
};

/** AES-256-GCM encrypt → ciphertext ‖ 16-byte tag. */
export const aeadEncryptFallback = (
  key: Uint8Array,
  nonce: Uint8Array,
  plaintext: Uint8Array,
  algorithm?: string | null,
): Uint8Array => {
  if (algorithm != null && algorithm !== "aes-256-gcm") {
    throw new Error(`aead: unsupported algorithm '${algorithm}'`);
  }
  if (key.length !== 32) throw new Error("aead: key must be 32 bytes");
  if (nonce.length !== 12) throw new Error("aead: nonce must be 12 bytes");
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([enc, cipher.getAuthTag()]));
};

/** AEAD decrypt; returns `null` on auth failure or malformed input. */
export const aeadDecrypt = (
  key: string | Uint8Array,
  nonce: string | Uint8Array,
  ciphertext: string | Uint8Array,
  algorithm?: string | null,
): Uint8Array | null => {
  const k = toBytes(key);
  const n = toBytes(nonce);
  const c = toBytes(ciphertext);
  const nv = nativeFor("aeadDecrypt");
  if (nv) {
    const result = nv.aeadDecrypt(k, n, c, algorithm ?? null);
    return result ? new Uint8Array(result) : null;
  }
  return aeadDecryptFallback(k, n, c, algorithm ?? null);
};

/** AES-256-GCM decrypt; returns `null` on auth failure or malformed input. */
export const aeadDecryptFallback = (
  key: Uint8Array,
  nonce: Uint8Array,
  ciphertext: Uint8Array,
  algorithm?: string | null,
): Uint8Array | null => {
  if (algorithm != null && algorithm !== "aes-256-gcm") return null;
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < 16) return null;
  const tag = ciphertext.subarray(ciphertext.length - 16);
  const body = ciphertext.subarray(0, ciphertext.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return new Uint8Array(Buffer.concat([decipher.update(body), decipher.final()]));
  } catch {
    return null;
  }
};
