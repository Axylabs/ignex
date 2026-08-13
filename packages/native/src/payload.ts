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
import { bunGunzipSync, bunGzipSync } from "./bun";
import { nativeFor } from "./runtime";
import { fromBytes, toBytes, toPlain } from "./util";

// ── Compression ─────────────────────────────────────────────────

/** gzip-compress `data` (optional 0–9 `level`, default 6). */
export const gzipCompress = (data: Uint8Array, level = 6): Uint8Array => {
  const n = nativeFor("gzipCompress");
  if (n) return toPlain(n.gzipCompress(data, level));
  // Under Bun, `Bun.gzipSync` beats the Rust addon (~2.0x) — never ship slower
  // than Bun's native.
  if (bunGzipSync) return toPlain(bunGzipSync(data, level));
  return toPlain(gzipSync(data, { level }));
};

/** gzip-decompress `data`. */
export const gzipDecompress = (data: Uint8Array): Uint8Array => {
  const n = nativeFor("gzipDecompress");
  if (n) return toPlain(n.gzipDecompress(data));
  if (bunGunzipSync) return toPlain(bunGunzipSync(data));
  return toPlain(gunzipSync(data));
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

/** brotli-decompress `data`. */
export const brotliDecompress = (data: Uint8Array): Uint8Array => {
  const n = nativeFor("brotliDecompress");
  return toPlain(n ? n.brotliDecompress(data) : brotliDecompressSync(data));
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
  if (n) return fromBytes(n.wsAcceptKey(toBytes(key)));
  return createHash("sha1")
    .update(key + WS_GUID)
    .digest("base64");
};
