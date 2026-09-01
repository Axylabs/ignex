/**
 * Payload codecs (native-accelerated where proven): gzip/brotli compression,
 * SSE event framing, and RFC 6455 WebSocket frame codecs.
 *
 * Compression fallbacks use Node `zlib` (sync) so the API surface stays
 * synchronous and identical to the native addon.
 */
import { createHash } from "node:crypto";
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync,
} from "node:zlib";
import { bunGzipSync, bunSha1Base64 } from "./bun";
import { isFfiActive } from "./ffi";
import { nativeFor } from "./runtime";
import { fromBytes, toBytes, toPlain, toStr } from "./util";

// ── Compression ─────────────────────────────────────────────────

/**
 * Default decompression-bomb cap (bytes) for the JS fallback paths.
 *
 * The native addon enforces its own 64 MiB cap inside Rust; the JS fallbacks
 * previously had NONE — a small malicious gzip/brotli body could expand to
 * gigabytes and exhaust the process. 64 MiB matches castrum's policy so both
 * backends share one safety envelope. Override per call via `opts`.
 */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Error thrown when a decompression result exceeds the bomb cap. */
export class PayloadTooLargeError extends Error {
  readonly code = "PAYLOAD_TOO_LARGE";
  constructor(message = "Decompressed payload exceeds the configured maximum size") {
    super(message);
    this.name = "PayloadTooLargeError";
  }
}

const MAX_OUTPUT_LENGTH_KEY = "maxOutputLength";

/** gunzip with a hard output cap (`maxOutputLength` throws ERANGE-style on overflow). */
const cappedGunzipSync = (data: Uint8Array, maxOutputLength: number): Uint8Array => {
  try {
    return gunzipSync(data, { [MAX_OUTPUT_LENGTH_KEY]: maxOutputLength });
  } catch (err) {
    if (err instanceof RangeError || (err as { code?: string }).code === "ERR_STRING_TOO_LONG") {
      throw new PayloadTooLargeError();
    }
    throw err;
  }
};

/** brotli-decompress with a hard output cap. */
const cappedBrotliDecompressSync = (data: Uint8Array, maxOutputLength: number): Uint8Array => {
  try {
    return brotliDecompressSync(data, { [MAX_OUTPUT_LENGTH_KEY]: maxOutputLength });
  } catch (err) {
    if (err instanceof RangeError) throw new PayloadTooLargeError();
    throw err;
  }
};

/** gzip-compress `data` (optional 0–9 `level`, default 6). */
export const gzipCompress = (data: Uint8Array, level = 6): Uint8Array => {
  const n = nativeFor("gzipCompress");
  if (n) return toPlain(n.gzipCompress(data, level));
  // Under Bun, `Bun.gzipSync` beats the Rust addon (~2.0x) — never ship slower
  // than Bun's native.
  if (bunGzipSync) return toPlain(bunGzipSync(data, level));
  return toPlain(gzipSync(data, { level }));
};

/**
 * gzip-decompress `data` with a decompression-bomb cap.
 *
 * @param data - The gzipped bytes.
 * @param opts - `maxOutputBytes` (default {@link DEFAULT_MAX_DECOMPRESSED_BYTES},
 *   matching the native 64 MiB cap). The native path is used only when it can
 *   honor the requested cap; otherwise the capped zlib path runs.
 * @throws {PayloadTooLargeError} when the output exceeds the cap.
 */
export const gzipDecompress = (
  data: Uint8Array,
  opts: { maxOutputBytes?: number } = {},
): Uint8Array => {
  const cap = Math.max(1, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES));
  const n = nativeFor("gzipDecompress");
  if (n && cap >= DEFAULT_MAX_DECOMPRESSED_BYTES) return toPlain(n.gzipDecompress(data));
  // Capped fallback: `Bun.gunzipSync` has no output-length bound, so the
  // capped path always goes through node:zlib's maxOutputLength guard.
  return toPlain(cappedGunzipSync(data, cap));
};

/** brotli-compress `data` (optional 0–11 `quality`, default 5). */
export const brotliCompress = (data: Uint8Array, quality = 5): Uint8Array => {
  const n = nativeFor("brotliCompress");
  return toPlain(
    n
      ? n.brotliCompress(data, quality)
      : brotliCompressSync(data, { params: { [constants.BROTLI_PARAM_QUALITY]: quality } }),
  );
};

/**
 * brotli-decompress `data` with a decompression-bomb cap (same contract as
 * {@link gzipDecompress}).
 *
 * @throws {PayloadTooLargeError} when the output exceeds the cap.
 */
export const brotliDecompress = (
  data: Uint8Array,
  opts: { maxOutputBytes?: number } = {},
): Uint8Array => {
  const cap = Math.max(1, Math.floor(opts.maxOutputBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES));
  const n = nativeFor("brotliDecompress");
  if (n && cap >= DEFAULT_MAX_DECOMPRESSED_BYTES) return toPlain(n.brotliDecompress(data));
  return toPlain(cappedBrotliDecompressSync(data, cap));
};

// ── SSE ─────────────────────────────────────────────────────────

/** Encode an SSE event frame (WHATWG format). */
export const sseEncode = (
  event: string | null,
  data: string | Uint8Array,
  id?: string | null,
  retry?: number | null,
): string => {
  // Selection: js — native FFI marshal loses for typical frames (x0.28) — see selection.ts.
  return sseEncodeFallback(event, data, id ?? null, retry ?? null);
};

/** WHATWG SSE framing: optional `id:`/`event:`/`retry:` lines, `data:` per line, trailing blank line. */
export const sseEncodeFallback = (
  event: string | null,
  data: string | Uint8Array,
  id: string | null,
  retry: number | null,
): string => {
  const out: string[] = [];
  if (id != null) out.push(`id: ${id}\n`);
  if (event != null) out.push(`event: ${event}\n`);
  if (retry != null) out.push(`retry: ${retry}\n`);
  const text = typeof data === "string" ? data : fromBytes(data);
  for (const line of text.split("\n")) out.push(`data: ${line}\n`);
  out.push("\n");
  return out.join("");
};

// ── WebSocket frames ────────────────────────────────────────────

/** RFC 6455 §5.7 example mask key — used by native so encode is deterministic. */
const DEFAULT_MASK = [0x37, 0xfa, 0x21, 0x3d];

/** A decoded RFC 6455 WebSocket frame. */
export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** Encode an RFC 6455 WebSocket frame. */
export const wsFrameEncode = (
  opcode: number,
  payload: Uint8Array,
  mask: boolean,
  fin: boolean,
): Uint8Array => {
  const n = nativeFor("wsFrameEncode");
  return toPlain(
    n
      ? n.wsFrameEncode(opcode, payload, mask, fin)
      : wsFrameEncodeFallback(opcode, payload, mask, fin),
  );
};

/** RFC 6455 §5.2 frame encode (deterministic mask when `mask` is true). */
export const wsFrameEncodeFallback = (
  opcode: number,
  payload: Uint8Array,
  mask: boolean,
  fin: boolean,
): Uint8Array => {
  const headerLen =
    2 + (payload.length > 125 ? (payload.length > 65_535 ? 8 : 2) : 0) + (mask ? 4 : 0);
  const out = new Uint8Array(headerLen + payload.length);
  let pos = 0;
  out[pos++] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0;
  const len = payload.length;
  if (len <= 125) {
    out[pos++] = maskBit | len;
  } else if (len <= 65_535) {
    out[pos++] = maskBit | 126;
    out[pos++] = (len >> 8) & 0xff;
    out[pos++] = len & 0xff;
  } else {
    out[pos++] = maskBit | 127;
    const dv = new DataView(out.buffer, out.byteOffset + pos, 8);
    dv.setBigUint64(0, BigInt(len), false);
    pos += 8;
  }
  if (mask) {
    out.set(DEFAULT_MASK, pos);
    pos += 4;
    for (let i = 0; i < payload.length; i++) {
      out[pos + i] = (payload[i] ?? 0) ^ (DEFAULT_MASK[i & 3] ?? 0);
    }
  } else {
    out.set(payload, pos);
  }
  return out;
};

/** Decode an RFC 6455 WebSocket frame; returns `null` on malformed input. */
export const wsFrameDecode = (data: Uint8Array): WsFrame | null => {
  const n = nativeFor("wsFrameDecode");
  if (n) {
    const frame = n.wsFrameDecode(data);
    return frame ? { fin: frame.fin, opcode: frame.opcode, payload: toPlain(frame.payload) } : null;
  }
  return wsFrameDecodeFallback(data);
};

/** RFC 6455 §5.2 frame decode; returns `null` on malformed input. */
export const wsFrameDecodeFallback = (data: Uint8Array): WsFrame | null => {
  if (data.length < 2) return null;
  const fin = ((data[0] ?? 0) & 0x80) !== 0;
  const opcode = (data[0] ?? 0) & 0x0f;
  const masked = ((data[1] ?? 0) & 0x80) !== 0;
  let len = (data[1] ?? 0) & 0x7f;
  let pos = 2;
  if (len === 126) {
    if (data.length < pos + 2) return null;
    len = ((data[pos] ?? 0) << 8) | (data[pos + 1] ?? 0);
    pos += 2;
  } else if (len === 127) {
    if (data.length < pos + 8) return null;
    const dv = new DataView(data.buffer, data.byteOffset + pos, 8);
    const big = dv.getBigUint64(0, false);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    len = Number(big);
    pos += 8;
  }
  let mask: Uint8Array | null = null;
  if (masked) {
    if (data.length < pos + 4) return null;
    mask = data.slice(pos, pos + 4);
    pos += 4;
  }
  if (data.length < pos + len) return null;
  const payload = data.slice(pos, pos + len);
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] = (payload[i] ?? 0) ^ (mask[i & 3] ?? 0);
  }
  return { fin, opcode, payload };
};

// ── WebSocket accept key ────────────────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** Compute the RFC 6455 Sec-WebSocket-Accept value from a client key. */
export const wsAcceptKey = (key: string): string => {
  const n = nativeFor("wsAcceptKey");
  if (n) {
    // C-ABI `cstring` ARG takes the raw key string (zero JS encode); NAPI bytes.
    if (isFfiActive()) {
      return (n as unknown as { wsAcceptKey(k: string): string }).wsAcceptKey(key);
    }
    return toStr(n.wsAcceptKey(toBytes(key)));
  }
  const plain = key + WS_GUID;
  // Under Bun, `Bun.CryptoHasher` SHA-1 beats `node:crypto` (~1.1–1.25x — see
  // docs/bun-internals.md) and yields the same standard-base64 accept value.
  if (bunSha1Base64) return bunSha1Base64(plain);
  return createHash("sha1").update(plain).digest("base64");
};
