#!/usr/bin/env bun
/**
 * JWT encode/decode speed: native (castrum Rust) vs pure-TS fallback.
 *
 * "encode" = JWT sign, "decode" = JWT verify. MEDIAN of interleaved trials
 * (bench-ffi methodology) for noise stability. Rows:
 *
 *   eddsa-sign    jwtSignEdDsa       (wrapper → native C-ABI/NAPI) vs fallback
 *   eddsa-verify  jwtVerifyEdDsa     (wrapper) vs fallback
 *   rust-sign     ffi.jwtSignEddsa   (pre-encoded claims → pure-Rust core, no
 *                                     JS stringify/encode — isolates the FFI
 *                                     cost from the wrapper)
 *   rust-verify   ffi.jwtVerifyEddsa (pre-parsed token → pure-Rust core)
 *   ed25519-sign  raw Ed25519 sign   (crypto-only, no JWT framing)
 *   ed25519-verify raw Ed25519 verify
 *   hs256-sign / hs256-verify        (existing HS256 op, for context)
 *
 * Usage:
 *   bun scripts/bench-jwt.ts                  # ffi (Bun) — default
 *   IGNEX_FFI_MODE=napi bun scripts/bench-jwt.ts   # NAPI transport
 *   IGNEX_NATIVE=off bun scripts/bench-jwt.ts       # addon off → baseline only
 */
import { type FfiSurface, getFfi } from "../packages/native/src/ffi";
import {
  ed25519Sign,
  ed25519SignFallback,
  ed25519Verify,
  ed25519VerifyFallback,
  generateEd25519Keypair,
  isNativeAvailable,
  jwtSign,
  jwtSignEdDsa,
  jwtSignEdDsaFallback,
  jwtSignFallback,
  jwtVerify,
  jwtVerifyEdDsa,
  jwtVerifyEdDsaFallback,
  jwtVerifyFallback,
} from "../packages/native/src/index";

const enc = new TextEncoder();

/** Median of samples (noise-stable center for FFI microbenchmarks). */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/** Ops/sec for a sync fn (warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = 250): number {
  for (let i = 0; i < 1_000; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

// ── Fixtures ────────────────────────────────────────────────────
const pair = generateEd25519Keypair();
// Raw DER bytes for the low-level fallback/ffi rows (the wrappers decode the
// base64url string internally).
const privDer = Buffer.from(pair.privateKey, "base64url");
const pubDer = Buffer.from(pair.publicKey, "base64url");
const secret = enc.encode("s".repeat(32));
const NOW = 1_700_000_000;
const TTL = 3600;

// Realistic claims (auth-module shape: sub + roles + permissions).
const claims = {
  sub: "user-123",
  roles: ["admin"],
  permissions: ["users:read", "users:write", "orders:read"],
};
const claimsJson = enc.encode(JSON.stringify(claims));

// Pre-signed tokens so verify benches a FIXED token (no signing inside the loop).
const eddsaToken = jwtSignEdDsa(claims, pair.privateKey, { ttlSeconds: TTL, nowSeconds: NOW });
const hs256Token = jwtSign(claims, secret, { ttlSeconds: TTL, nowSeconds: NOW });

const ffi = getFfi();
const surface = ffi as FfiSurface; // only deref'd under `ffi` guards

const TRIALS = 5;
const WIN = 1.05;

interface BenchRow {
  name: string;
  native: () => void;
  fallback: () => void;
  rustCore?: (() => void) | undefined;
}

const rows: BenchRow[] = [
  {
    name: "eddsa-sign",
    native: () => jwtSignEdDsa(claims, pair.privateKey, { ttlSeconds: TTL, nowSeconds: NOW }),
    fallback: () => jwtSignEdDsaFallback(claims, privDer, TTL, NOW),
    rustCore: ffi ? () => surface.jwtSignEddsa(claimsJson, privDer, TTL, NOW) : undefined,
  },
  {
    name: "eddsa-verify",
    native: () => jwtVerifyEdDsa(eddsaToken, pair.publicKey, { nowSeconds: NOW + 1 }),
    fallback: () => jwtVerifyEdDsaFallback(eddsaToken, pubDer, NOW + 1),
    rustCore: ffi
      ? () => surface.jwtVerifyEddsa(enc.encode(eddsaToken), pubDer, NOW + 1)
      : undefined,
  },
  {
    name: "ed25519-sign",
    native: () => ed25519Sign(claimsJson, pair.privateKey),
    fallback: () => ed25519SignFallback(privDer, claimsJson),
  },
  {
    name: "ed25519-verify",
    native: () =>
      ed25519Verify(claimsJson, ed25519Sign(claimsJson, pair.privateKey), pair.publicKey),
    fallback: () =>
      ed25519VerifyFallback(pubDer, claimsJson, ed25519SignFallback(privDer, claimsJson)),
  },
  {
    name: "hs256-sign",
    native: () => jwtSign(claims, secret, { ttlSeconds: TTL, nowSeconds: NOW }),
    fallback: () => jwtSignFallback(claims, secret, TTL, NOW),
  },
  {
    name: "hs256-verify",
    native: () => jwtVerify(hs256Token, secret, { nowSeconds: NOW + 1 }),
    fallback: () => jwtVerifyFallback(hs256Token, secret, NOW + 1),
  },
];

function run(): void {
  console.log(
    `mode: ${isNativeAvailable() ? "NATIVE" : "FALLBACK"}${ffi ? " (C-ABI ffi live)" : isNativeAvailable() ? " (NAPI)" : " (no addon — baseline)"}\n`,
  );
  console.log(
    `JWT encode/decode per-op (median of ${TRIALS} interleaved trials; win ≥${WIN.toFixed(2)}x):\n`,
  );

  const pad = (s: string, w: number): string => s.padEnd(w);
  console.log(
    `${pad("op", 16)} ${pad("native", 10)} ${pad("fallback", 10)} ${pad("ratio", 8)} ${pad("rust-core", 10)} verdict`,
  );

  for (const row of rows) {
    if (!isNativeAvailable()) {
      const f = opsPerSec(row.fallback);
      console.log(
        `${pad(row.name, 16)} ${pad("-", 10)} ${pad(String(Math.round(f)), 10)} ${pad("-", 8)} ${pad("-", 10)} n/a (addon off)`,
      );
      continue;
    }

    const nSamples: number[] = [];
    const jSamples: number[] = [];
    for (let t = 0; t < TRIALS; t++) {
      nSamples.push(opsPerSec(row.native));
      jSamples.push(opsPerSec(row.fallback));
    }
    const n = median(nSamples);
    const j = median(jSamples);
    const ratio = n / j;

    let rc = "-";
    if (row.rustCore) {
      const rSamples: number[] = [];
      for (let t = 0; t < TRIALS; t++) rSamples.push(opsPerSec(row.rustCore as () => void));
      rc = String(Math.round(median(rSamples)));
    }

    const verdict = ratio >= WIN ? "◀ native wins" : ratio <= 1 / WIN ? "js stays" : "parity";
    console.log(
      `${pad(row.name, 16)} ${pad(String(Math.round(n)), 10)} ${pad(String(Math.round(j)), 10)} ${pad(ratio.toFixed(2), 8)} ${pad(rc, 10)} ${verdict}`,
    );
  }

  console.log(
    "\nNotes: native = @ignex/native wrapper (includes JSON.stringify + FFI/NAPI crossing). rust-core = raw ffi call on pre-encoded input (pure-Rust, no JS framing).",
  );
}

run();
