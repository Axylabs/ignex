#!/usr/bin/env bun
/**
 * C-ABI (`bun:ffi`) vs JS-fallback per-op benchmark — MEDIAN-based.
 *
 * The wrappers in `@ignex/native` hard-wire several ops that the C-ABI surface
 * (`ffi.ts`) already covers to the JS fallback (etag, queryPairs, cookiePairs,
 * formPairs, …) because castrum's NAPI-based `select-native` measured JS wins.
 * On the C-ABI transport the crossing is ~10-20ns (vs ~100-350ns NAPI), so an
 * op that LOST on NAPI can WIN on C-ABI. This script measures the REAL C-ABI
 * path (ffi op + required unpack) against the exact JS fallback the wrapper
 * would otherwise run, using the median of interleaved trials for noise
 * stability. Proven winners (median ratio >= 1.05) are candidates to wire into
 * the wrappers.
 *
 *   bun scripts/bench-ffi.ts            # ffi vs JS (median of 3 interleaved)
 *   IGNEX_FFI_MODE=napi ...             # napi vs JS (for comparison)
 *   IGNEX_NATIVE=off ...                # ffi unavailable → skip native rows
 */
import { bunCrc32, bunHmacSha256 } from "../packages/native/src/bun";
import { type FfiSurface, getFfi } from "../packages/native/src/ffi";
import {
  cookiePairsFallback,
  etagFallback,
  fnv1a64Fallback,
  formPairsFallback,
  queryPairsFallback,
  randomTokenFallback,
  toBytes,
  validateEmailFallback,
  validateIpv4Fallback,
  validateIpv6Fallback,
  validateUuidFallback,
} from "../packages/native/src/index";
import { readPairsPacked } from "../packages/native/src/packed";

const ffi = getFfi();
// Non-null typed handles — the native closures below only ever run under the
// `!ffi` guard inside `run()`, so a null surface never reaches them. `as`
// keeps the noNonNullAssertion lint happy (the `!` operator is banned).
const surface = ffi as FfiSurface;
const bunCrc = bunCrc32 as (data: Uint8Array) => number;
const bunHmac = bunHmacSha256 as (key: Uint8Array, data: Uint8Array) => Uint8Array;
const enc = new TextEncoder();

// Representative inputs (≥64B so FFI amortizes; mirrors castrum's select-native).
const bigChunk = "x".repeat(64);
const queryText = `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}&name=Ada%20Lovelace`;
const queryBytes = enc.encode(queryText);
const cookieText = Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(
  " ",
);
const cookieBytes = enc.encode(cookieText);
const formText = `name=Ada%20Lovelace&role=engineer&active=true&tags=a&tags=b&lang=en&chunk=${bigChunk}`;
const formBytes = enc.encode(formText);
const etagText = `hello world, etag sample ${bigChunk}`;
const etagBytes = enc.encode(etagText);
const hashBytes = enc.encode(`hash sample ${bigChunk}`);
const jsonDoc = '{"id":1,"name":"widget","tags":["a","b","c"],"nested":{"x":true}}';
const jsonBytes = enc.encode(jsonDoc);

/** Median of interleaved samples (noise-stable center for FFI microbenchmarks). */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Ops/sec for a sync fn (warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = 200): number {
  for (let i = 0; i < 1_000; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

interface BenchOp {
  name: string;
  native: () => unknown;
  fallback: () => unknown;
}

const hmacKey = enc.encode("k".repeat(32));
const hmacData = enc.encode(`hmac sample ${bigChunk}`);
const WIN = 1.05;

// C-ABI native = ffi op + required JS unpack (the REAL wrapper cost).
const benchOps: BenchOp[] = [
  {
    name: "queryPairs",
    native: () => readPairsPacked(surface.queryParsePacked(queryBytes)),
    fallback: () => queryPairsFallback(toBytes(queryText)),
  },
  {
    name: "cookiePairs",
    native: () => readPairsPacked(surface.cookieParsePacked(cookieBytes)),
    fallback: () => cookiePairsFallback(toBytes(cookieText)),
  },
  {
    name: "formPairs",
    native: () => readPairsPacked(surface.formParsePacked(formBytes)),
    fallback: () => formPairsFallback(toBytes(formText)),
  },
  {
    name: "etag",
    native: () => surface.etag(etagBytes),
    fallback: () => etagFallback(toBytes(etagText), false),
  },
  {
    name: "validateEmail",
    native: () => surface.validateEmail("ada@example.com"),
    fallback: () => validateEmailFallback("ada@example.com"),
  },
  {
    name: "validateUuid",
    native: () => surface.validateUuid("123e4567-e89b-12d3-a456-426614174000"),
    fallback: () => validateUuidFallback("123e4567-e89b-12d3-a456-426614174000"),
  },
  {
    name: "validateIpv4",
    native: () => surface.validateIpv4("192.168.0.1"),
    fallback: () => validateIpv4Fallback("192.168.0.1"),
  },
  {
    name: "validateIpv6",
    native: () => surface.validateIpv6("2001:db8::1"),
    fallback: () => validateIpv6Fallback("2001:db8::1"),
  },
  {
    name: "fnv1a64",
    native: () => surface.fnv1a64(hashBytes),
    fallback: () => fnv1a64Fallback(hashBytes),
  },
  // BUN_WINS ops — Bun's native built-ins were measured faster than the Rust
  // addon over NAPI (~300ns crossing); on C-ABI (~10-20ns) Rust may now win.
  {
    name: "crc32 (ffi vs Bun.hash)",
    native: () => surface.crc32(hashBytes),
    fallback: () => bunCrc(hashBytes),
  },
  {
    name: "jsonValid (ffi vs JSON.parse)",
    native: () => surface.jsonValid(jsonBytes),
    fallback: () => {
      try {
        JSON.parse(jsonDoc);
      } catch {
        /* ignore */
      }
    },
  },
  {
    name: "hmacSha256 (ffi vs Bun.Hasher)",
    native: () => surface.hmacSha256(hmacKey, hmacData),
    fallback: () => bunHmac(hmacKey, hmacData),
  },
  {
    name: "randomToken (ffi vs webcrypto)",
    native: () => surface.randomToken(16),
    fallback: () => randomTokenFallback(16),
  },
];

const TRIALS = 5;

function run(): void {
  if (!ffi) {
    console.log("C-ABI unavailable (IGNEX_NATIVE=off / Node / forced napi) — no native rows.");
  }
  console.log(
    `C-ABI vs JS per-op (median of ${TRIALS} interleaved trials; win ≥${WIN.toFixed(2)}x):\n`,
  );
  const rows: Array<{ name: string; native: number; js: number; ratio: number }> = [];
  for (const op of benchOps) {
    if (!ffi) {
      rows.push({
        name: op.name,
        native: Number.NaN,
        js: opsPerSec(op.fallback),
        ratio: Number.NaN,
      });
      continue;
    }
    const nSamples: number[] = [];
    const jSamples: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      nSamples.push(opsPerSec(op.native));
      jSamples.push(opsPerSec(op.fallback));
    }
    const n = median(nSamples);
    const j = median(jSamples);
    rows.push({ name: op.name, native: n, js: j, ratio: n / j });
  }

  const pad = (s: string, w: number): string => s.padEnd(w);
  console.log(`${pad("op", 18)} ${pad("ffi", 11)} ${pad("js", 11)} ${pad("ratio", 8)} verdict`);
  for (const r of rows) {
    const verdict = Number.isFinite(r.ratio)
      ? r.ratio >= WIN
        ? "◀ WIRE (native wins)"
        : r.ratio <= 1 / WIN
          ? "js stays"
          : "parity"
      : "n/a";
    console.log(
      `${pad(r.name, 18)} ${pad(Number.isFinite(r.native) ? String(Math.round(r.native)) : "-", 11)} ${pad(String(Math.round(r.js)), 11)} ${pad(Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "-", 8)} ${verdict}`,
    );
  }
}

run();
