/**
 * Packed wire-format helpers for native parse outputs.
 *
 * The native addon returns small binary buffers with a fixed little-endian
 * layout — `[u32 count] repeated { [u32 len] [bytes] }` — for parsed pairs
 * (query/cookie/form). These helpers unpack that layout into plain JS.
 *
 * Decode uses the bun:ffi fast-read path (`ffi-read.ts`): `read.u32/u64` (no
 * `DataView` allocation) + `CString` (engine-native UTF-8→string), with a
 * DataView/TextDecoder fallback under Node. Bun-first, Node second-class.
 */
import { ffiBuf, ffiString, ffiU32, ffiU64 } from "./ffi-read";

/** Pack an array of byte items into the castrum packed-input layout. */
export const packBatch = (items: ReadonlyArray<Uint8Array>): Uint8Array => {
  let total = 4;
  for (const it of items) total += 4 + it.byteLength;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, items.length, true);
  let pos = 4;
  for (const it of items) {
    dv.setUint32(pos, it.byteLength, true);
    pos += 4;
    out.set(it, pos);
    pos += it.byteLength;
  }
  return out;
};

/** Unpack a packed bitset result → one 0/1 byte per item. */
export const unpackBitset = (packed: Uint8Array): Uint8Array => {
  if (packed.byteLength < 4) return new Uint8Array(0);
  const b = ffiBuf(packed);
  const count = ffiU32(b, 0);
  const bits = packed.subarray(4);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const byte = bits[i >> 3] ?? 0;
    out[i] = (byte >> (i & 7)) & 1;
  }
  return out;
};

/** Unpack a packed byte-results buffer → array of byte subarrays. */
export const unpackByteResults = (packed: Uint8Array): Uint8Array[] => {
  if (packed.byteLength < 4) return [];
  const b = ffiBuf(packed);
  const count = ffiU32(b, 0);
  const out: Uint8Array[] = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = ffiU32(b, pos);
    pos += 4;
    out.push(packed.subarray(pos, pos + len));
    pos += len;
  }
  return out;
};

/** Unpack a packed u32 result → `Uint32Array` (one per item). */
export const unpackU32Array = (packed: Uint8Array): Uint32Array => {
  if (packed.byteLength < 4) return new Uint32Array(0);
  const b = ffiBuf(packed);
  const count = ffiU32(b, 0);
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = ffiU32(b, 4 + i * 4);
  return out;
};

/** Unpack a packed u64 result → `BigUint64Array` (unsigned, one per item). */
export const unpackU64ArrayAsBigInt = (packed: Uint8Array): BigUint64Array => {
  if (packed.byteLength < 4) return new BigUint64Array(0);
  const b = ffiBuf(packed);
  const count = ffiU32(b, 0);
  const out = new BigUint64Array(count);
  for (let i = 0; i < count; i++) out[i] = ffiU64(b, 4 + i * 8);
  return out;
};

/**
 * Read one packed `[u32 count] repeated { [u32 len] [bytes] }` pair section
 * starting at `start`, returning the pairs and the next position (so a caller
 * can decode consecutive sections from one buffer). Shared by
 * {@link readPairsPacked} (whole-buffer section) and `route-wire`'s result
 * decoder (query + cookie sections in one buffer).
 */
export const readPairsSection = (
  b: ReturnType<typeof ffiBuf>,
  start: number,
): { readonly pairs: Array<[string, string]>; readonly nextPos: number } => {
  const count = ffiU32(b, start);
  const pairs: Array<[string, string]> = [];
  let pos = start + 4;
  for (let i = 0; i < count; i++) {
    const nameLen = ffiU32(b, pos);
    pos += 4;
    const name = ffiString(b, pos, nameLen);
    pos += nameLen;
    const valueLen = ffiU32(b, pos);
    pos += 4;
    const value = ffiString(b, pos, valueLen);
    pos += valueLen;
    pairs.push([name, value]);
  }
  return { pairs, nextPos: pos };
};

/** Unpack a packed `[name, value]`-pairs buffer. */
export const readPairsPacked = (buf: Uint8Array): Array<[string, string]> =>
  readPairsSection(ffiBuf(buf), 0).pairs;

/**
 * Unpack a packed BATCH-of-pairs result → one pair list per input item.
 *
 * Outer layout: `[u32 item_count]{[u32 len][pairs_packed]}` where each
 * `pairs_packed` is the `[u32 pair_count]{[u32 name_len][name]
 * [u32 value_len][value]}` layout decoded by {@link readPairsPacked}. This is
 * the output wire format of the native `*ParseBatchPacked` entry points
 * (query/cookie/form).
 */
export const unpackPairBatches = (buf: Uint8Array): Array<Array<[string, string]>> => {
  if (buf.byteLength < 4) return [];
  const b = ffiBuf(buf);
  const count = ffiU32(b, 0);
  const out: Array<Array<[string, string]>> = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = ffiU32(b, pos);
    pos += 4;
    out.push(readPairsPacked(buf.subarray(pos, pos + len)));
    pos += len;
  }
  return out;
};

/** Reduce a pair list into a plain object (last value wins per key). */
export const pairsToObject = (pairs: ReadonlyArray<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
};
