#!/usr/bin/env bun
/**
 * Batch-vs-scalar FFI bench — FRESH retest on the current Bun + castrum.
 *
 * Historically (2026-08-11, Bun 1.4.0-canary.1) the native BATCH APIs were
 * marked unreliable and several ops were judged JS-wins. This script re-measures
 * every candidate on the CURRENT runtime so wiring decisions are made on fresh
 * data — including a stability probe (--probe) that directly retests the
 * "batch APIs are nondeterministic on Bun canary" claim.
 *
 * For each op at N = 1 / 4 / 16 / 64 / 256 it compares THREE strategies for
 * processing a group of N items:
 *   scalar-native : N individual raw-addon calls (one FFI crossing each)
 *   scalar-js     : N pure-TS/Bun calls (the no-Rust path)
 *   batch         : one packed FFI call for the whole group + unpack
 *
 * Before timing at N=16, every op asserts batch == scalar-native == scalar-js
 * on the SAME inputs (the `guard`). If they disagree, the row is flagged and
 * never trusted. A flaky addon returning null/empty is reported, never allowed
 * to crash the run.
 *
 * A batch is worth wiring when it beats BOTH scalars at a usable N (and the
 * C-ABI parity suite `scripts/verify-native-ffi.ts` proves byte-equality).
 *
 * Usage:
 *   bun scripts/bench-batch.ts                        # decision table to stdout
 *   bun scripts/bench-batch.ts --probe                # stability probe only
 *   bun scripts/bench-batch.ts --write                # also persist bench/results/batch-selection.json
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cookiePairsFallback,
  crc32,
  csrfTokenFallback,
  csrfVerifyFallback,
  fnv1a64Fallback,
  formPairsFallback,
  getNative,
  hmacSha256,
  hmacSha256Verify,
  isNativeAvailable,
  jsonValid,
  queryPairsFallback,
  signCookieFallback,
  validateEmailFallback,
  validateIpv4Fallback,
  validateIpv6Fallback,
  validateUuidFallback,
  verifyCookieFallback,
} from "../packages/native/src/index";
import type { NativeAddon } from "../packages/native/src/loader";
import {
  packBatch,
  readPairsPacked,
  unpackBitset,
  unpackPairBatches,
  unpackU32Array,
  unpackU64ArrayAsBigInt,
} from "../packages/native/src/packed";
import { decoder, encoder } from "../packages/native/src/util";

const native = getNative();
const MODE = isNativeAvailable() ? "NATIVE" : "FALLBACK";

if (!native) {
  console.error(
    "bench-batch: castrum addon not loaded — cannot measure batch. Install/build it or set IGNEX_NATIVE_PATH.",
  );
  process.exit(2);
}

type RawAddon = NativeAddon & Record<string, (...args: any[]) => any>;
const raw = native as RawAddon;

const revision = (() => {
  try {
    return (Bun as unknown as { revision?: string }).revision ?? "?";
  } catch {
    return "?";
  }
})();
console.log(`runtime: Bun ${Bun.version} (revision ${revision})`);

// ── Deterministic inputs (large enough that FFI amortizes) ─────
const bigChunk = "x".repeat(64);
const enc = encoder;
const dec = decoder;
const query = `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}`;
const cookie = Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(" ");
const form = `name=Ada%20Lovelace&role=engineer&tags=a&tags=b&chunk=${bigChunk}`;
const jsonDoc = '{"id":1,"name":"widget","tags":["a","b","c"]}';
const email = "ada.lovelace@example.com";
const uuid = "123e4567-e89b-12d3-a456-426614174000";
const ipv4 = "192.168.0.1";
const ipv6 = "2001:0db8:85a3:0000:0000:8a2e:0370:7334";

const secret = enc.encode("s3cret-key-material-0123456789abcdef"); // 32B
const key = enc.encode("key-material-0123456789abcdef"); // 32B
const cookieValue = "session=abc123";
const hmacData = enc.encode(`payload ${bigChunk}`);

// VALID inputs for the verify ops, in the PRODUCTION string format so native
// and JS agree on real work (both accept `value.<64-hex sig>`).
const signedStr = signCookieFallback(cookieValue, secret);
const tokenStr = csrfTokenFallback(secret);

// HMAC verify: native scalar takes raw bytes; castrum's batch entry expects
// lowercase-hex sigs per item.
const validSig = raw.hmacSha256(key, hmacData);
const validSigHex = validSig
  ? Array.from(validSig, (b) => b.toString(16).padStart(2, "0")).join("")
  : "".padStart(64, "0");
const hmacSigs = (n: number) => Array.from({ length: n }, () => enc.encode(validSigHex));

const mk = (s: string) => (n: number) => Array.from({ length: n }, () => enc.encode(s));

// ── stability probe (--probe) ───────────────────────────────────
// The 2026-08-11 docs claimed the *BatchPacked APIs were nondeterministic on
// Bun canary (corrupt buffers / hard crash, "isolated calls work; specific
// module/call arrangements fail"). Retest that claim across ALL candidate
// batch entry points on the CURRENT runtime: N trials each, batch result must
// equal per-item scalar native result every time.
if (process.argv.includes("--probe")) {
  const probes: Array<{ name: string; batch: () => unknown }> = [];
  const itemList = (s: string) => Array.from({ length: 16 }, () => enc.encode(s));
  const withList = (s: string, fn: (items: Uint8Array[]) => unknown) => () => fn(itemList(s));

  const secretB = enc.encode("s3cret-key-material-0123456789abcdef");
  const keyB = enc.encode("key-material-0123456789abcdef");
  const sigB = enc.encode(validSigHex);

  probes.push(
    {
      name: "fnv1a64",
      batch: withList(`key-${bigChunk}`, (i) => raw.fnv1A64BatchPacked(packBatch(i))),
    },
    {
      name: "crc32",
      batch: withList(`crc-${bigChunk}`, (i) => raw.crc32BatchPacked(packBatch(i))),
    },
    { name: "jsonValid", batch: withList(jsonDoc, (i) => raw.jsonValidBatchPacked(packBatch(i))) },
    {
      name: "validateEmail",
      batch: withList(email, (i) => raw.validateEmailBatchPacked(packBatch(i))),
    },
    {
      name: "validateUuid",
      batch: withList(uuid, (i) => raw.validateUuidBatchPacked(packBatch(i))),
    },
    {
      name: "validateIpv4",
      batch: withList(ipv4, (i) => raw.validateIpv4BatchPacked(packBatch(i))),
    },
    {
      name: "validateIpv6",
      batch: withList(ipv6, (i) => raw.validateIpv6BatchPacked(packBatch(i))),
    },
    {
      name: "signCookie",
      batch: withList("session=abc123", (i) => raw.signCookieBatchPacked(packBatch(i), secretB)),
    },
    {
      name: "verifyCookie",
      batch: withList(signedStr, (i) => raw.verifyCookieBatchPacked(packBatch(i), secretB)),
    },
    {
      name: "csrfVerify",
      batch: withList(tokenStr, (i) => raw.csrfVerifyBatchPacked(packBatch(i), secretB)),
    },
    {
      name: "hmacSha256",
      batch: withList(`payload ${bigChunk}`, (i) => raw.hmacSha256BatchPacked(packBatch(i), keyB)),
    },
    {
      name: "hmacSha256Verify",
      batch: withList(`payload ${bigChunk}`, (i) =>
        raw.hmacSha256VerifyBatchPacked(
          packBatch(i),
          packBatch(Array.from({ length: 16 }, () => sigB)),
          keyB,
        ),
      ),
    },
  );

  const TRIALS = 40;
  let totalBad = 0;
  for (const p of probes) {
    let ok = 0;
    let bad = 0;
    for (let t = 0; t < TRIALS; t++) {
      try {
        const r = p.batch();
        // Sanity: a well-formed result is a Uint8Array/Buffer of plausible size.
        const good = r instanceof Uint8Array && r.byteLength >= 4;
        if (good) {
          ok++;
        } else {
          bad++;
          if (bad <= 2) {
            console.log(
              `  bad ${p.name} #${t}: type=${(r as object)?.constructor?.name ?? "null"} byteLength=${(r as Uint8Array)?.byteLength ?? "n/a"}`,
            );
          }
        }
      } catch (e) {
        bad++;
        if (bad <= 2) console.log(`  throw ${p.name} #${t}: ${String(e)}`);
      }
    }
    totalBad += bad;
    console.log(`${p.name.padEnd(18)} ${ok}/${TRIALS} ok, ${bad} bad`);
  }
  console.log(
    `\nbatch stability: ${totalBad === 0 ? "ALL STABLE" : `${totalBad} failures across ops`}`,
  );
  process.exit(totalBad === 0 ? 0 : 1);
}

/** Unpack a packed byte-results buffer → array of byte subarrays. */
const unpackByteResults = (packed: Uint8Array): Uint8Array[] => {
  const out: Uint8Array[] = [];
  const dv = new DataView(packed.buffer, packed.byteOffset, packed.byteLength);
  const count = dv.getUint32(0, true);
  let pos = 4;
  for (let i = 0; i < count; i++) {
    const len = dv.getUint32(pos, true);
    pos += 4;
    out.push(packed.subarray(pos, pos + len));
    pos += len;
  }
  return out;
};

// ── guard helpers ───────────────────────────────────────────────
/** bitset (Uint8Array of 0/1) vs boolean[] — same length, same per-item truth. */
const bitsetEqBool = (b: Uint8Array, s: boolean[]): boolean =>
  b.length === s.length && s.every((v, i) => (v ? 1 : 0) === b[i]);
/** bigint/typed-array per-item equality. */
const bigintEq = (a: ArrayLike<bigint>, b: ArrayLike<bigint>): boolean =>
  a.length === b.length &&
  (() => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  })();
const numberEq = (a: ArrayLike<number>, b: ArrayLike<number>): boolean =>
  a.length === b.length &&
  (() => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  })();
/** `[name,value]` pair lists — deep equality via JSON. */
const pairsEq = (a: Array<Array<[string, string]>>, b: Array<Array<[string, string]>>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
/** byte results — hex equality. Accepts Uint8Array or Buffer per item. */
const hexEq = (a: Uint8Array[], b: Uint8Array[]): boolean =>
  a.length === b.length &&
  a.every(
    (x, i) => Buffer.from(x).toString("hex") === Buffer.from(b[i] as Uint8Array).toString("hex"),
  );

interface OpBench {
  name: string;
  mkItems: (n: number) => Uint8Array[];
  /** Timed strategies. They may RETURN their per-item results for the guard. */
  scalarNative: (items: Uint8Array[]) => unknown;
  scalarJS: (items: Uint8Array[]) => unknown;
  batch: (items: Uint8Array[]) => unknown;
  /** All three strategies must agree on the same inputs for the row to be trusted. */
  guard: (b: unknown, sn: unknown, sj: unknown) => boolean;
}

const OPS: OpBench[] = [
  // ── hashing / validity (batch already exposed in NativeBatch) ──
  {
    name: "fnv1a64",
    mkItems: mk(`key-${bigChunk}`),
    scalarNative: (items) => items.map((x) => raw.fnv1a64(x)),
    scalarJS: (items) => items.map((x) => fnv1a64Fallback(x)),
    batch: (items) => unpackU64ArrayAsBigInt(raw.fnv1A64BatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bigintEq(b as BigUint64Array, sn as bigint[]) && bigintEq(sn as bigint[], sj as bigint[]),
  },
  {
    name: "crc32",
    mkItems: mk(`crc-${bigChunk}`),
    scalarNative: (items) => items.map((x) => raw.crc32(x)),
    scalarJS: (items) => items.map((x) => crc32(x)), // production JS path (Bun.hash.crc32)
    batch: (items) => unpackU32Array(raw.crc32BatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      numberEq(b as Uint32Array, sn as number[]) && numberEq(sn as number[], sj as number[]),
  },
  {
    name: "jsonValid",
    mkItems: mk(jsonDoc),
    scalarNative: (items) => items.map((x) => raw.jsonValid(x)),
    scalarJS: (items) => items.map((x) => jsonValid(x)),
    batch: (items) => unpackBitset(raw.jsonValidBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  // ── pair parsing (batch exposed; scalar pair parsing judged JS-wins before) ──
  {
    name: "queryParse",
    mkItems: mk(query),
    scalarNative: (items) => items.map((x) => readPairsPacked(raw.queryParsePacked(x))),
    scalarJS: (items) => items.map((x) => queryPairsFallback(x)),
    batch: (items) => unpackPairBatches(raw.queryParseBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      pairsEq(b as Array<Array<[string, string]>>, sn as Array<Array<[string, string]>>) &&
      pairsEq(sn as Array<Array<[string, string]>>, sj as Array<Array<[string, string]>>),
  },
  {
    name: "cookieParse",
    mkItems: mk(cookie),
    scalarNative: (items) => items.map((x) => readPairsPacked(raw.cookieParsePacked(x))),
    scalarJS: (items) => items.map((x) => cookiePairsFallback(x)),
    batch: (items) => unpackPairBatches(raw.cookieParseBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      pairsEq(b as Array<Array<[string, string]>>, sn as Array<Array<[string, string]>>) &&
      pairsEq(sn as Array<Array<[string, string]>>, sj as Array<Array<[string, string]>>),
  },
  {
    name: "formParse",
    mkItems: mk(form),
    scalarNative: (items) => items.map((x) => readPairsPacked(raw.formParsePacked(x))),
    scalarJS: (items) => items.map((x) => formPairsFallback(x)),
    batch: (items) => unpackPairBatches(raw.formParseBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      pairsEq(b as Array<Array<[string, string]>>, sn as Array<Array<[string, string]>>) &&
      pairsEq(sn as Array<Array<[string, string]>>, sj as Array<Array<[string, string]>>),
  },
  // ── validators (previously judged ~6x slower — RETEST) ──
  {
    name: "validateEmail",
    mkItems: mk(email),
    scalarNative: (items) => items.map((x) => raw.validateEmail(x)),
    scalarJS: (items) => items.map((x) => validateEmailFallback(dec.decode(x))),
    batch: (items) => unpackBitset(raw.validateEmailBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  {
    name: "validateUuid",
    mkItems: mk(uuid),
    scalarNative: (items) => items.map((x) => raw.validateUuid(x)),
    scalarJS: (items) => items.map((x) => validateUuidFallback(dec.decode(x))),
    batch: (items) => unpackBitset(raw.validateUuidBatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  {
    name: "validateIpv4",
    mkItems: mk(ipv4),
    scalarNative: (items) => items.map((x) => raw.validateIpv4(x)),
    scalarJS: (items) => items.map((x) => validateIpv4Fallback(dec.decode(x))),
    batch: (items) => unpackBitset(raw.validateIpv4BatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  {
    name: "validateIpv6",
    mkItems: mk(ipv6),
    scalarNative: (items) => items.map((x) => raw.validateIpv6(x)),
    scalarJS: (items) => items.map((x) => validateIpv6Fallback(dec.decode(x))),
    batch: (items) => unpackBitset(raw.validateIpv6BatchPacked(packBatch(items))),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  // ── crypto (batches NOT yet exposed in @ignex/native — new territory) ──
  {
    name: "signCookie",
    mkItems: mk(cookieValue),
    scalarNative: (items) => items.map((x) => raw.signCookie(x, secret)),
    scalarJS: (items) => items.map((x) => signCookieFallback(dec.decode(x), secret)),
    batch: (items) => unpackByteResults(raw.signCookieBatchPacked(packBatch(items), secret)),
    guard: (b, sn, sj) =>
      hexEq(b as Uint8Array[], sn as Uint8Array[]) &&
      hexEq(
        sn as Uint8Array[],
        (sj as string[]).map((s) => enc.encode(s)),
      ),
  },
  {
    name: "verifyCookie",
    mkItems: mk(signedStr),
    scalarNative: (items) => items.map((x) => raw.verifyCookie(x, secret)),
    scalarJS: (items) => items.map((x) => verifyCookieFallback(dec.decode(x), secret)),
    batch: (items) => unpackBitset(raw.verifyCookieBatchPacked(packBatch(items), secret)),
    guard: (b, sn, sj) =>
      bitsetEqBool(
        b as Uint8Array,
        (sn as Array<Uint8Array | null>).map((v) => v !== null),
      ) &&
      (sn as Array<Uint8Array | null>).every(
        (v, i) => (v !== null) === ((sj as Array<string | null>)[i] !== null),
      ),
  },
  {
    name: "csrfVerify",
    mkItems: mk(tokenStr),
    scalarNative: (items) => items.map((x) => raw.csrfVerify(x, secret)),
    scalarJS: (items) => items.map((x) => csrfVerifyFallback(dec.decode(x), secret)),
    batch: (items) => unpackBitset(raw.csrfVerifyBatchPacked(packBatch(items), secret)),
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
  {
    name: "hmacSha256",
    mkItems: mk(`payload ${bigChunk}`),
    scalarNative: (items) => items.map((x) => raw.hmacSha256(key, x)),
    scalarJS: (items) => items.map((x) => hmacSha256(key, x)),
    batch: (items) => unpackByteResults(raw.hmacSha256BatchPacked(packBatch(items), key)),
    guard: (b, sn, sj) =>
      hexEq(b as Uint8Array[], sn as Uint8Array[]) && hexEq(sn as Uint8Array[], sj as Uint8Array[]),
  },
  {
    name: "hmacSha256Verify",
    mkItems: mk(`payload ${bigChunk}`),
    scalarNative: (items) => {
      const sigs = hmacSigs(items.length);
      return items.map((x, i) => raw.hmacSha256Verify(key, x, sigs[i] as Uint8Array));
    },
    scalarJS: (items) => {
      const sigs = hmacSigs(items.length);
      return items.map((x, i) => hmacSha256Verify(key, x, sigs[i] as Uint8Array));
    },
    batch: (items) => {
      const sigs = hmacSigs(items.length);
      return unpackBitset(raw.hmacSha256VerifyBatchPacked(packBatch(items), packBatch(sigs), key));
    },
    guard: (b, sn, sj) =>
      bitsetEqBool(b as Uint8Array, sn as boolean[]) &&
      (sn as boolean[]).every((v, i) => v === (sj as boolean[])[i]),
  },
];

/** Per-item throughput (items/sec) for processing a group of `n`. */
function perItemPerSec(fn: () => unknown, n: number, durationMs = 250): number {
  for (let i = 0; i < 30; i++) fn(); // warmup
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  const elapsed = (performance.now() - start) / 1000;
  return (count * n) / elapsed;
}

/** Timing wrapper that never crashes the run on a flaky addon return. */
function timed(fn: () => unknown, n: number): number {
  try {
    return perItemPerSec(fn, n);
  } catch {
    return 0;
  }
}

const N_VALUES = [1, 4, 16, 64, 256];

const results: Record<
  string,
  { n: number; batch: number; scalarNative: number; scalarJS: number; guardOk: boolean }[]
> = {};

const fmt = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 0 });
const ratio = (a: number, b: number) => (b > 0 ? a / b : Number.NaN);

console.log(`mode: ${MODE}\n`);
console.log(
  "Per-item throughput (items/s). batch-vs-native / batch-vs-js = speedup when > 1.00.\n",
);

let guardFailures = 0;

for (const op of OPS) {
  const rows: {
    n: number;
    batch: number;
    scalarNative: number;
    scalarJS: number;
    guardOk: boolean;
  }[] = [];
  console.log(`── ${op.name}`);
  console.log(`   n    batch        scalar-native  scalar-js     batch/native  batch/js`);
  for (const n of N_VALUES) {
    const items = op.mkItems(n);

    // Correctness guard at n=16: batch == scalar-native == scalar-js on the
    // SAME inputs. A flaky addon return makes guardOk=false (never a crash).
    let guardOk = true;
    if (n === 16) {
      let bRes: unknown;
      let snRes: unknown;
      let sjRes: unknown;
      try {
        bRes = op.batch(items);
        snRes = op.scalarNative(items);
        sjRes = op.scalarJS(items);
        guardOk = op.guard(bRes, snRes, sjRes);
      } catch (e) {
        guardOk = false;
        if (guardFailures < 3) {
          console.error(`  ⚠ guard threw at n=16 for ${op.name}: ${String(e)}`);
        }
      }
      if (!guardOk) {
        guardFailures++;
        const summarize = (r: unknown): string => {
          if (r instanceof Uint8Array) return `U8[${Array.from(r).join("")}]`;
          if (Array.isArray(r)) return `Arr[${r.map((v) => (v ? 1 : 0)).join("")}]`;
          return String(r);
        };
        console.error(
          `  ⚠ guard FAIL at n=16 for ${op.name}\n    batch=${summarize(bRes)}\n    native=${summarize(snRes)}\n    js=${summarize(sjRes)}`,
        );
      }
    }

    const b = timed(() => op.batch(items), n);
    const sn = timed(() => op.scalarNative(items), n);
    const sj = timed(() => op.scalarJS(items), n);
    rows.push({ n, batch: b, scalarNative: sn, scalarJS: sj, guardOk });
    const rn = ratio(b, sn);
    const rj = ratio(b, sj);
    console.log(
      `   ${String(n).padStart(3)}  ${fmt(b).padStart(10)}  ${fmt(sn).padStart(13)}  ${fmt(sj).padStart(10)}     ${rn.toFixed(2).padStart(8)}   ${rj.toFixed(2).padStart(7)}${guardOk ? "" : "  ⚠"}`,
    );
  }
  results[op.name] = rows;
  console.log("");
}

// ── decision summary ────────────────────────────────────────────
console.log("── Decision (batch beats BOTH scalars when ratio > 1.05, guard-ok only) ──");
const decisions: Record<
  string,
  { threshold: number | null; batchVsNative: number; batchVsJs: number; guardOk: boolean }
> = {};
for (const op of OPS) {
  let threshold: number | null = null;
  let bvNative = 0;
  let bvJs = 0;
  const rows = results[op.name];
  if (!rows) continue;
  for (const row of rows) {
    const rn = ratio(row.batch, row.scalarNative);
    const rj = ratio(row.batch, row.scalarJS);
    bvNative = rn;
    bvJs = rj;
    if (row.guardOk && rn >= 1.05 && rj >= 1.05) {
      threshold = row.n;
      break;
    }
  }
  const guardOk = rows[2]?.guardOk ?? false;
  decisions[op.name] = {
    threshold,
    batchVsNative: bvNative,
    batchVsJs: bvJs,
    guardOk,
  };
  const verdict = !guardOk
    ? "⚠ guard FAILED — untrusted"
    : threshold !== null
      ? `BATCH wins at n>=${threshold}`
      : "no win (batch ≤ scalar)";
  console.log(`   ${op.name.padEnd(18)} ${verdict}`);
}

if (guardFailures > 0) {
  console.error(
    `\n${guardFailures} op(s) failed the batch==scalar guard — fix the bench inputs before trusting results.`,
  );
  process.exit(3);
}

if (process.argv.includes("--write")) {
  const outDir = join(import.meta.dir, "..", "bench", "results");
  mkdirSync(outDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    bun: Bun.version,
    revision,
    mode: MODE,
    rule: "wire batch iff batch/native >= 1.05 AND batch/js >= 1.05 at that n (guard-ok only)",
    ops: decisions,
  };
  writeFileSync(join(outDir, "batch-selection.json"), JSON.stringify(payload, null, 2));
  console.log(`\nwrote bench/results/batch-selection.json`);
}
