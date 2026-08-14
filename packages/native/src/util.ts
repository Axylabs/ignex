/**
 * Shared byte/encoding utilities for the native layer.
 *
 * Everything here is pure and built on Node built-ins only, so the fallback
 * path is testable under any runtime (Bun, Node, vitest) and behaves
 * byte-identically to the Rust addon.
 */

import { createHmac } from "node:crypto";

/** Shared UTF-8 encoder/decoder (avoid per-call allocation). */
export const encoder = new TextEncoder();
/** Shared UTF-8 decoder (avoid per-call allocation). */
export const decoder = new TextDecoder();

/** Coerce a string or bytes into `Uint8Array`. */
export const toBytes = (input: string | Uint8Array): Uint8Array =>
  typeof input === "string" ? encoder.encode(input) : input;

/** Decode bytes into a string. */
export const fromBytes = (bytes: Uint8Array): string => decoder.decode(bytes);

/**
 * String-or-bytes → string. The C-ABI surface returns plain strings
 * (`cstring` — the engine clones them natively); the NAPI fallback returns
 * bytes. This normalizes either so wrappers work across both transports.
 */
export const toStr = (v: string | Uint8Array): string =>
  typeof v === "string" ? v : decoder.decode(v);

/**
 * Normalize a `Buffer` (or any bytes) into a plain `Uint8Array` view of the
 * same memory. Keeps deep-equality tests and JSON inspection consistent
 * whether the bytes came from native (Node `Buffer`) or the fallbacks.
 */
export const toPlain = (bytes: Uint8Array): Uint8Array =>
  typeof Buffer !== "undefined" && Buffer.isBuffer(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : bytes;

/** Constant-time byte comparison (length mismatch → false). */
export const ctEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
};

// ── CRC-32 (IEEE 802.3) — compatible with crc32fast (used by native etag) ──

const CRC_TABLE = /* @__PURE__ */ (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 checksum (returns an unsigned 32-bit number). */
export const crc32 = (input: Uint8Array): number => {
  let crc = 0xffffffff;
  for (let i = 0; i < input.length; i++) {
    crc = (CRC_TABLE[(crc ^ (input[i] as number)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

// ── hex / base64url ─────────────────────────────────────────────

const HEX_RE = /^[0-9a-fA-F]*$/;

/** Lowercase hex encoding. */
export const hexEncode = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("hex");

/** Strict hex decoding; returns `null` on malformed input. */
export const hexDecode = (hex: string): Uint8Array | null => {
  if (hex.length % 2 !== 0 || !HEX_RE.test(hex)) return null;
  return new Uint8Array(Buffer.from(hex, "hex"));
};

/** Base64url (RFC 7515) encoding — no padding. */
export const b64urlEncode = (bytes: Uint8Array): string =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");

/** Base64url decoding — returns `null` on malformed input. */
export const b64urlDecode = (input: string): Uint8Array | null => {
  try {
    return new Uint8Array(Buffer.from(input, "base64url"));
  } catch {
    return null;
  }
};

// ── HMAC-SHA256 (node:crypto — available in Bun and Node) ───────

/** HMAC-SHA256 digest of `data` under `key`. */
export const hmacSha256Bytes = (key: Uint8Array, data: Uint8Array): Uint8Array =>
  new Uint8Array(createHmac("sha256", key).update(data).digest());
