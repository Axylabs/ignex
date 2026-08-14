/**
 * Native BATCH primitives — one packed FFI call for many items.
 *
 * The castrum addon exposes `*BatchPacked` entry points that amortize the
 * FFI crossing across a whole array of inputs. This is the "move compute to
 * Rust" counterpart of the scalar auto-selection: bulk work routes through a
 * single Rust call where it measurably wins.
 *
 * MEASURED on this machine (fresh 2026-08-14, real addon, `scripts/bench-batch.ts`):
 *   fnv1a64        batch wins at n>=16 (batch/native 1.2-2.7x; batch/js ~15-36x)
 *   jsonValid      batch wins at n>=16 (1.2-2.8x)
 *   signCookie     batch wins at n>=4  (1.8-3.2x)
 *   verifyCookie   batch wins at n>=4  (1.9-5.2x)
 *   hmacSha256     batch wins at n>=4  (1.5-3.2x)
 *   hmacSha256Verify batch wins at n>=16 (1.3-2.8x)
 *   csrfVerify     batch wins at n>=16 (1.4-2.8x)
 *   crc32          no win (JS/Bun wins) — kept for bulk parity
 *   query/cookie/formParse  no win (JS scalar wins at all N) — kept for bulk
 *     parity; core parseQueries/parseCookies use the scalar path (2026-08-14).
 *   validate*      NOT exposed: batch loses ~6x vs the JS regex loop (packing
 *     overhead), so scalar selection (validate* → js) already picks the win.
 *
 * Every function falls back to a per-item JS loop when the addon is absent
 * (parity, not performance, is guaranteed without native). The batch path was
 * previously unwired because of a Bun-canary crash; that is root-caused and
 * verified byte-correct (`bun scripts/verify-native-batch.ts` in castrum),
 * and a fresh 12-op stability probe passes 40/40 per op (2026-08-14).
 */

import { csrfVerifyFallback, signCookieFallback, verifyCookieFallback } from "./crypto";
import { cookiePairsFallback } from "./http/cookie";
import { formPairsFallback } from "./http/form";
import { queryPairsFallback } from "./http/query";
import {
  packBatch,
  unpackBitset,
  unpackByteResults,
  unpackPairBatches,
  unpackU32Array,
  unpackU64ArrayAsBigInt,
} from "./packed";
import { native } from "./runtime";
import { crc32 as crc32ScalarFallback, decoder, encoder, hexEncode, hmacSha256Bytes } from "./util";

/** Packed batch surface: one native FFI call for many items, with a per-item JS fallback. */
export interface NativeBatch {
  /** Bit-per-item validity (0/1) for well-formed JSON inputs. */
  jsonValid(items: ReadonlyArray<string | Uint8Array>): Uint8Array;
  /** CRC-32 per item (unsigned). */
  crc32(items: ReadonlyArray<string | Uint8Array>): Uint32Array;
  /** FNV-1a 64-bit per item (unsigned bigint). */
  fnv1a64(items: ReadonlyArray<string | Uint8Array>): BigUint64Array;
  /** Decode many query strings → one `[name, value]` pair list per input. */
  queryParse(items: ReadonlyArray<string | Uint8Array>): Array<Array<[string, string]>>;
  /** Decode many `Cookie` header values → one `[name, value]` pair list per input. */
  cookieParse(items: ReadonlyArray<string | Uint8Array>): Array<Array<[string, string]>>;
  /** Decode many `application/x-www-form-urlencoded` bodies → one pair list per input. */
  formParse(items: ReadonlyArray<string | Uint8Array>): Array<Array<[string, string]>>;
  /** Sign many cookie values → one `value.<64-hex>` per input. */
  signCookie(items: ReadonlyArray<string | Uint8Array>, secret: Uint8Array): Uint8Array[];
  /** Verify many signed cookies → bit-per-item validity (0/1). */
  verifyCookie(items: ReadonlyArray<string | Uint8Array>, secret: Uint8Array): Uint8Array;
  /** Verify many CSRF tokens → bit-per-item validity (0/1). */
  csrfVerify(items: ReadonlyArray<string | Uint8Array>, secret: Uint8Array): Uint8Array;
  /** HMAC-SHA256 per input (64 lowercase-hex bytes). */
  hmacSha256(items: ReadonlyArray<string | Uint8Array>, key: Uint8Array): Uint8Array[];
  /** Verify many `data` + hex-signature pairs → bit-per-item validity (0/1). */
  hmacSha256Verify(
    items: ReadonlyArray<string | Uint8Array>,
    sigs: ReadonlyArray<Uint8Array>,
    key: Uint8Array,
  ): Uint8Array;
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
      queryParse: (items) => unpackPairBatches(n.queryParseBatchPacked(packed(items))),
      cookieParse: (items) => unpackPairBatches(n.cookieParseBatchPacked(packed(items))),
      formParse: (items) => unpackPairBatches(n.formParseBatchPacked(packed(items))),
      signCookie: (items, secret) =>
        unpackByteResults(n.signCookieBatchPacked(packed(items), secret)),
      verifyCookie: (items, secret) =>
        unpackBitset(n.verifyCookieBatchPacked(packed(items), secret)),
      csrfVerify: (items, secret) => unpackBitset(n.csrfVerifyBatchPacked(packed(items), secret)),
      hmacSha256: (items, key) => unpackByteResults(n.hmacSha256BatchPacked(packed(items), key)),
      hmacSha256Verify: (items, sigs, key) =>
        unpackBitset(
          n.hmacSha256VerifyBatchPacked(packed(items), packBatch(sigs.map(toBytes)), key),
        ),
    };
  }

  // Pure-TS fallbacks (parity, byte-compatible with the native outputs).
  const bitset = (bools: boolean[]): Uint8Array => new Uint8Array(bools.map((b) => (b ? 1 : 0)));

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
      let i = 0;
      for (const item of items) out[i++] = crc32ScalarFallback(toBytes(item)) >>> 0;
      return out;
    },
    fnv1a64: (items) => {
      // Mirrors the scalar FNV-1a 64-bit implementation bit-for-bit.
      const out = new BigUint64Array(items.length);
      let i = 0;
      for (const item of items) {
        let h = 0xcbf29ce484222325n;
        const bytes = toBytes(item);
        for (const byte of bytes) {
          h ^= BigInt(byte);
          h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
        }
        out[i++] = h;
      }
      return out;
    },
    queryParse: (items) => items.map((it) => [...queryPairsFallback(toBytes(it))]),
    cookieParse: (items) => items.map((it) => [...cookiePairsFallback(toBytes(it))]),
    formParse: (items) => items.map((it) => [...formPairsFallback(toBytes(it))]),
    signCookie: (items, secret) =>
      items.map((it) => encoder.encode(signCookieFallback(decoder.decode(toBytes(it)), secret))),
    verifyCookie: (items, secret) =>
      bitset(items.map((it) => verifyCookieFallback(decoder.decode(toBytes(it)), secret) !== null)),
    csrfVerify: (items, secret) =>
      bitset(items.map((it) => csrfVerifyFallback(decoder.decode(toBytes(it)), secret))),
    hmacSha256: (items, key) =>
      items.map((it) => encoder.encode(hexEncode(hmacSha256Bytes(key, toBytes(it))))),
    hmacSha256Verify: (items, sigs, key) =>
      bitset(
        items.map((it, i) => {
          const sig = sigs[i] ? decoder.decode(sigs[i]) : "";
          return hexEncode(hmacSha256Bytes(key, toBytes(it))) === sig;
        }),
      ),
  };
};

/** Lazy singleton batch surface (never throws; JS fallback when no addon). */
export const batch: NativeBatch = buildBatch();
