/**
 * Native BATCH primitives — one packed FFI call for many items.
 *
 * The castrum addon exposes `*BatchPacked` entry points that amortize the
 * FFI crossing across a whole array of inputs. This is the "move compute to
 * Rust" counterpart of the scalar auto-selection: bulk work routes through a
 * single Rust call where it measurably wins.
 *
 * MEASURED on this machine (2026-08-11, real addon, 100-item batches):
 *   fnv1a64   batch 4.67x vs per-item JS loop
 *   crc32     batch 1.45x vs per-item JS loop
 *   jsonValid batch 1.57x (small docs) / 1.85x (500-row docs) vs JSON.parse
 *
 * NOT exposed: validate* batches. Although castrum's registry shows large
 * batch wins, that benchmark compared batch vs a NATIVE-scalar loop (100 FFI
 * crossings). Against flux's fast JS regex (~50ns/email) the packing +
 * unpacking overhead makes the batch ~6x SLOWER — the JS loop wins, so the
 * scalar auto-selection (validate* → js) already picks the faster path.
 *
 * Every function falls back to a per-item JS loop when the addon is absent
 * (parity, not performance, is guaranteed without native). The batch path was
 * previously unwired because of a Bun-canary crash; that is root-caused and
 * verified byte-correct (`bun scripts/verify-native-batch.ts` in castrum).
 */

import { packBatch, unpackBitset, unpackU32Array, unpackU64ArrayAsBigInt } from "./packed";
import { native } from "./runtime";
import { crc32 as crc32ScalarFallback, decoder, encoder } from "./util";

export interface NativeBatch {
  /** Bit-per-item validity (0/1) for well-formed JSON inputs. */
  jsonValid(items: ReadonlyArray<string | Uint8Array>): Uint8Array;
  /** CRC-32 per item (unsigned). */
  crc32(items: ReadonlyArray<string | Uint8Array>): Uint32Array;
  /** FNV-1a 64-bit per item (unsigned bigint). */
  fnv1a64(items: ReadonlyArray<string | Uint8Array>): BigUint64Array;
}

const toBytes = (input: string | Uint8Array): Uint8Array =>
  typeof input === "string" ? encoder.encode(input) : input;

/** Build the native batch surface (or a per-item JS fallback when absent). */
export const buildBatch = (): NativeBatch => {
  const n = native;

  const packed = (items: ReadonlyArray<string | Uint8Array>): Uint8Array =>
    packBatch(items.map(toBytes));

  if (n) {
    return {
      jsonValid: (items) => {
        // The zero-DOM native scan wins for large/streaming docs and beats
        // JSON.parse even on small docs once batched (measured 1.57–1.85x).
        return unpackBitset(n.jsonValidBatchPacked(packed(items)));
      },
      crc32: (items) => unpackU32Array(n.crc32BatchPacked(packed(items))),
      fnv1a64: (items) => unpackU64ArrayAsBigInt(n.fnv1A64BatchPacked(packed(items))),
    };
  }

  // Pure-TS fallbacks (parity, byte-compatible with the native outputs).
  return {
    jsonValid: (items) =>
      new Uint8Array(
        items.map((it) => {
          try {
            JSON.parse(typeof it === "string" ? it : decoder.decode(it));
            return 1;
          } catch {
            return 0;
          }
        }),
      ),
    crc32: (items) => {
      const out = new Uint32Array(items.length);
      for (let i = 0; i < items.length; i++) out[i] = crc32ScalarFallback(toBytes(items[i]!)) >>> 0;
      return out;
    },
    fnv1a64: (items) => {
      // Mirrors the scalar FNV-1a 64-bit implementation bit-for-bit.
      const out = new BigUint64Array(items.length);
      for (let i = 0; i < items.length; i++) {
        let h = 0xcbf29ce484222325n;
        const bytes = toBytes(items[i]!);
        for (let j = 0; j < bytes.length; j++) {
          h ^= BigInt(bytes[j]!);
          h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        out[i] = h;
      }
      return out;
    },
  };
};

/** Lazy singleton batch surface (never throws; JS fallback when no addon). */
export const batch: NativeBatch = buildBatch();
