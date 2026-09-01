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
 *
 * HARDENING (memory safety): every decoder VALIDATES its wire before reading —
 * lengths/counts are bounds-checked against the buffer BEFORE any read. Under
 * Bun the ffi readers dereference raw pointers (`read.u32(ptr, off)` /
 * `CString(ptr, off, len)` have no bounds knowledge), so a corrupt or hostile
 * wire would otherwise read adjacent process memory (uncatchable SIGSEGV);
 * under Node `subarray` clamps silently, producing divergent garbage. Both now
 * fail FAST with {@link PackedWireError}: the request-level callers treat any
 * decode failure as "native result unusable" and fall back to the byte-parity
 * JS path (route prelude catch, ingress fault handling). Counts are also
 * structurally bounded (`count ≤ remaining/min-item-bytes`) so a lying count
 * can never drive a large typed-array allocation.
 */
import { type FfiBuf, ffiBuf, ffiString, ffiU32, ffiU64 } from "./ffi-read";

/** Thrown when a packed buffer violates its declared wire layout. */
export class PackedWireError extends Error {
  constructor(section: string, detail: string) {
    super(`packed wire (${section}): ${detail}`);
    this.name = "PackedWireError";
  }
}

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

/** Read a u32 at `off` or fail-fast when the read would leave the buffer. */
const u32Checked = (b: FfiBuf, off: number, section: string): number => {
  if (off < 0 || off + 4 > b.buf.byteLength) {
    throw new PackedWireError(section, `u32 read at ${off} exceeds buffer (${b.buf.byteLength}B)`);
  }
  return ffiU32(b, off);
};

/** Unpack a packed bitset result → one 0/1 byte per item. */
export const unpackBitset = (packed: Uint8Array): Uint8Array => {
  if (packed.byteLength < 4) return new Uint8Array(0);
  const b = ffiBuf(packed);
  const len = packed.byteLength;
  const count = u32Checked(b, 0, "bitset");
  // Structural bound: 8 items per remaining byte — a larger count is a lie.
  if (count > (len - 4) * 8) {
    throw new PackedWireError("bitset", `count ${count} exceeds capacity of ${len - 4}B payload`);
  }
  const bits = packed.subarray(4);
  const out = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const byte = bits[i >> 3] ?? 0;
    out[i] = (byte >> (i & 7)) & 1;
  }
  return out;
};

/** Unpack a packed u32 result → `Uint32Array` (one per item). */
export const unpackU32Array = (packed: Uint8Array): Uint32Array => {
  if (packed.byteLength < 4) return new Uint32Array(0);
  const b = ffiBuf(packed);
  const len = packed.byteLength;
  const count = u32Checked(b, 0, "u32-array");
  if (count > (len - 4) >> 2) {
    throw new PackedWireError(
      "u32-array",
      `count ${count} exceeds capacity of ${len - 4}B payload`,
    );
  }
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = ffiU32(b, 4 + i * 4);
  return out;
};

/** Unpack a packed u64 result → `BigUint64Array` (unsigned, one per item). */
export const unpackU64ArrayAsBigInt = (packed: Uint8Array): BigUint64Array => {
  if (packed.byteLength < 4) return new BigUint64Array(0);
  const b = ffiBuf(packed);
  const len = packed.byteLength;
  const count = u32Checked(b, 0, "u64-array");
  if (count > Math.floor((len - 4) / 8)) {
    throw new PackedWireError(
      "u64-array",
      `count ${count} exceeds capacity of ${len - 4}B payload`,
    );
  }
  const out = new BigUint64Array(count);
  for (let i = 0; i < count; i++) out[i] = ffiU64(b, 4 + i * 8);
  return out;
};

/** Minimum encoded size of one pair: two u32 length fields, zero-length strings. */
const MIN_PAIR_BYTES = 8;

/**
 * Read one packed `[u32 count] repeated { [u32 len] [bytes] }` pair section
 * starting at `start`, returning the pairs and the next position (so a caller
 * can decode consecutive sections from one buffer). Shared by
 * {@link readPairsPacked} (whole-buffer section) and `route-wire`'s result
 * decoder (query + cookie sections in one buffer).
 *
 * Throws {@link PackedWireError} when the declared layout exceeds the buffer —
 * never reads past the end (raw-pointer reads under Bun would segfault).
 */
export const readPairsSection = (
  b: FfiBuf,
  start: number,
): { readonly pairs: Array<[string, string]>; readonly nextPos: number } => {
  const len = b.buf.byteLength;
  const count = u32Checked(b, start, "pairs");
  // Each pair encodes in at least MIN_PAIR_BYTES — bound count up-front so a
  // lying count can neither loop unboundedly nor over-allocate `pairs`.
  if (count > (len - start - 4) / MIN_PAIR_BYTES) {
    throw new PackedWireError(
      "pairs",
      `pair count ${count} exceeds capacity of ${Math.max(0, len - start - 4)}B payload`,
    );
  }
  const pairs: Array<[string, string]> = [];
  let pos = start + 4;
  for (let i = 0; i < count; i++) {
    const nameLen = u32Checked(b, pos, "pairs");
    pos += 4;
    if (nameLen > len - pos)
      throw new PackedWireError("pairs", `name length ${nameLen} exceeds buffer`);
    const name = ffiString(b, pos, nameLen);
    pos += nameLen;
    const valueLen = u32Checked(b, pos, "pairs");
    pos += 4;
    if (valueLen > len - pos)
      throw new PackedWireError("pairs", `value length ${valueLen} exceeds buffer`);
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
 *
 * Throws {@link PackedWireError} on any section whose declared length leaves
 * the buffer.
 */
export const unpackPairBatches = (buf: Uint8Array): Array<Array<[string, string]>> => {
  if (buf.byteLength < 4) return [];
  const b = ffiBuf(buf);
  const len = buf.byteLength;
  const count = u32Checked(b, 0, "batch");
  if (count > (len - 4) / MIN_PAIR_BYTES) {
    throw new PackedWireError(
      "batch",
      `item count ${count} exceeds capacity of ${len - 4}B payload`,
    );
  }
  const out: Array<Array<[string, string]>> = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const sectionLen = u32Checked(b, pos, "batch");
    pos += 4;
    if (sectionLen > len - pos) {
      throw new PackedWireError("batch", `section length ${sectionLen} exceeds buffer`);
    }
    out.push(readPairsPacked(buf.subarray(pos, pos + sectionLen)));
    pos += sectionLen;
  }
  return out;
};

/**
 * Unpack a packed BYTE-ITEMS result (`[u32 count]{[u32 len][bytes]}`) → one
 * `Uint8Array` per item (the wire of `signCookieBatchPacked` /
 * `hmacSha256BatchPacked`). Throws {@link PackedWireError} on any length that
 * leaves the buffer.
 */
export const unpackByteItems = (packed: Uint8Array): Array<Uint8Array> => {
  if (packed.byteLength < 4) return [];
  const b = ffiBuf(packed);
  const len = packed.byteLength;
  const count = u32Checked(b, 0, "byte-items");
  // Each item encodes in at least 4 bytes (its length field).
  if (count > (len - 4) >> 2) {
    throw new PackedWireError(
      "byte-items",
      `count ${count} exceeds capacity of ${len - 4}B payload`,
    );
  }
  const out: Array<Uint8Array> = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const itemLen = u32Checked(b, pos, "byte-items");
    pos += 4;
    if (itemLen > len - pos) {
      throw new PackedWireError("byte-items", `item length ${itemLen} exceeds buffer`);
    }
    // Plain-Uint8Array view (NOT `.subarray`, which preserves a Node Buffer
    // receiver when the NAPI addon handed us one — deep-equality parity with
    // the scalar impls requires the same type, not just the same bytes).
    out.push(new Uint8Array(packed.buffer, packed.byteOffset + pos, itemLen));
    pos += itemLen;
  }
  return out;
};

/** Reduce a pair list into a plain object (last value wins per key). */
export const pairsToObject = (pairs: ReadonlyArray<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
};
