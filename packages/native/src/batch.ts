/**
 * @fileoverview Typed BATCH wrappers over castrum's `*BatchPacked` crypto
 * entry points — the measured bulk winners that previously existed only as
 * raw addon symbols with zero production-facing wrappers.
 *
 * Measured verdicts (`bench/results/batch-selection.json`, stable per the
 * 2026-08-14 40/40 stability probe):
 *   signCookie        n≥4   ~2.05× vs the JS scalar loop
 *   verifyCookie      n≥4   ~2.16×
 *   csrfVerify        n≥16  ~4.0×
 *   hmacSha256        n≥4   ~1.09×
 *   hmacSha256Verify  n≥16  ~1.36×
 *
 * Contract (mirrors every scalar wrapper):
 * - Below the MEASURED threshold (or without the addon) the call is a plain
 *   JS loop over the proven scalar impls — never slower than the app doing it
 *   itself, byte-identical results.
 * - A native attempt that throws or decodes wrong degrades to the JS loop and
 *   reports through telemetry. Batch ops NEVER break a caller.
 * - Byte-parity: batch output === scalar output for every item (parity tests
 *   assert it on both the fallback-only and real-addon paths).
 */

import { csrfVerify, hmacSha256, hmacSha256Verify, signCookie, verifyCookie } from "./crypto";
import { getNative } from "./loader";
import { packBatch, unpackBitset, unpackByteItems } from "./packed";
import { reportDegradation } from "./telemetry";
import { fromBytes, toBytes } from "./util";

/** The flat NAPI surface may or may not ship a given batch symbol. */
const batchFn = (name: string): ((...a: unknown[]) => unknown) | null => {
  const native = getNative() as Record<string, unknown> | null;
  if (!native) return null;
  const fn = native[name];
  return typeof fn === "function" ? (fn as (...a: unknown[]) => unknown) : null;
};

/**
 * Run one packed batch op natively; `null` when unavailable/failed (caller
 * falls back to the JS loop). Centralizes the degrade-and-report policy.
 */
const runBatch = <T>(
  op: string,
  symbol: string,
  threshold: number,
  n: number,
  exec: (fn: (...a: unknown[]) => unknown) => T,
): T | null => {
  if (n < threshold) return null;
  const fn = batchFn(symbol);
  if (!fn) return null;
  try {
    return exec(fn);
  } catch (err) {
    reportDegradation(
      "call-failed",
      op,
      `batch op failed (${err instanceof Error ? err.message : String(err)}) — JS scalar loop took over`,
    );
    return null;
  }
};

// ── Signed cookies ───────────────────────────────────────────────

/**
 * Sign many cookie values under ONE secret in a single crossing.
 * Output[i] === `signCookie(values[i], secret)` (byte-parity).
 */
export const signCookieBatch = (
  values: ReadonlyArray<string>,
  secret: string | Uint8Array,
): string[] => {
  const s = toBytes(secret);
  const nativeOut =
    values.length >= 4
      ? runBatch<string[]>("signCookie.batch", "signCookieBatchPacked", 4, values.length, (fn) => {
          const items = unpackByteItems(
            fn(packBatch(values.map((v) => toBytes(v))), s) as Uint8Array,
          );
          return items.map(fromBytes);
        })
      : null;
  if (nativeOut) return nativeOut;
  return values.map((v) => signCookie(v, s));
};

/**
 * Verify many signed tokens under ONE secret in a single crossing.
 * Output[i] is the VALIDITY of `tokens[i]` (the wire carries a bitset; use
 * the scalar {@link verifyCookie} when you need the value back).
 */
export const verifyCookieBatch = (
  tokens: ReadonlyArray<string>,
  secret: string | Uint8Array,
): boolean[] => {
  const s = toBytes(secret);
  const nativeOut =
    tokens.length >= 4
      ? runBatch<boolean[]>(
          "verifyCookie.batch",
          "verifyCookieBatchPacked",
          4,
          tokens.length,
          (fn) => {
            const bits = unpackBitset(fn(packBatch(tokens.map(toBytes)), s) as Uint8Array);
            return Array.from(bits, (b) => b === 1);
          },
        )
      : null;
  if (nativeOut) return nativeOut;
  return tokens.map((t) => verifyCookie(t, s) !== null);
};

// ── CSRF ─────────────────────────────────────────────────────────

/**
 * Constant-time verify of many CSRF tokens in a single crossing
 * (~4× at n≥16). Output[i] === `csrfVerify(tokens[i], secret)`.
 */
export const csrfVerifyBatch = (
  tokens: ReadonlyArray<string | Uint8Array>,
  secret: string | Uint8Array,
): boolean[] => {
  const s = toBytes(secret);
  const nativeOut =
    tokens.length >= 16
      ? runBatch<boolean[]>(
          "csrfVerify.batch",
          "csrfVerifyBatchPacked",
          16,
          tokens.length,
          (fn) => {
            const bits = unpackBitset(fn(packBatch(tokens.map(toBytes)), s) as Uint8Array);
            return Array.from(bits, (b) => b === 1);
          },
        )
      : null;
  if (nativeOut) return nativeOut;
  return tokens.map((t) => csrfVerify(t, s));
};

// ── HMAC-SHA256 ─────────────────────────────────────────────────

/**
 * HMAC-SHA256 of MANY messages under ONE key in a single crossing.
 * Output[i] === `hmacSha256(key, data[i])` (64 lowercase-hex bytes).
 */
export const hmacSha256Batch = (
  key: string | Uint8Array,
  data: ReadonlyArray<string | Uint8Array>,
): Uint8Array[] => {
  const k = toBytes(key);
  const nativeOut =
    data.length >= 4
      ? runBatch<Uint8Array[]>("hmacSha256.batch", "hmacSha256BatchPacked", 4, data.length, (fn) =>
          unpackByteItems(fn(packBatch(data.map(toBytes)), k) as Uint8Array),
        )
      : null;
  if (nativeOut) return nativeOut;
  return data.map((d) => hmacSha256(k, d));
};

/**
 * Constant-time verify of MANY HMAC-SHA256 signatures under ONE key in a
 * single crossing. Output[i] === `hmacSha256Verify(key, data[i], sigs[i])`.
 */
export const hmacSha256VerifyBatch = (
  key: string | Uint8Array,
  data: ReadonlyArray<string | Uint8Array>,
  sigs: ReadonlyArray<string | Uint8Array>,
): boolean[] => {
  const k = toBytes(key);
  const nativeOut =
    data.length >= 16 && sigs.length === data.length
      ? runBatch<boolean[]>(
          "hmacSha256Verify.batch",
          "hmacSha256VerifyBatchPacked",
          16,
          data.length,
          (fn) => {
            const bits = unpackBitset(
              fn(packBatch(data.map(toBytes)), packBatch(sigs.map(toBytes)), k) as Uint8Array,
            );
            return Array.from(bits, (b) => b === 1);
          },
        )
      : null;
  if (nativeOut) return nativeOut;
  return data.map((d, i) => hmacSha256Verify(k, d, sigs[i] as string | Uint8Array));
};
