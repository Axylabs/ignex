/**
 * Packed wire-format helpers for native parse outputs.
 *
 * The native addon returns small binary buffers with a fixed little-endian
 * layout — `[u32 count] repeated { [u32 len] [bytes] }` — for parsed pairs
 * (query/cookie/form). These helpers unpack that layout into plain JS.
 */
import { decoder } from "./util";

/** Unpack a packed `[name, value]`-pairs buffer. */
export const readPairsPacked = (buf: Uint8Array): Array<[string, string]> => {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const count = dv.getUint32(0, true);
  const out: Array<[string, string]> = [];
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint32(pos, true);
    pos += 4;
    const name = decoder.decode(buf.subarray(pos, pos + nameLen));
    pos += nameLen;
    const valueLen = dv.getUint32(pos, true);
    pos += 4;
    const value = decoder.decode(buf.subarray(pos, pos + valueLen));
    pos += valueLen;
    out.push([name, value]);
  }
  return out;
};

/** Reduce a pair list into a plain object (last value wins per key). */
export const pairsToObject = (pairs: ReadonlyArray<[string, string]>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) out[k] = v;
  return out;
};
