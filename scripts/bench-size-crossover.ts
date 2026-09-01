/**
 * @fileoverview Size-crossover calibration: find the byte threshold where the
 * native (C-ABI) path starts beating the JS/Bun path per op.
 *
 * The SELECTION table makes STATIC per-op decisions, but several ops flip
 * winner depending on input size — small inputs lose to boundary/transcode
 * cost while large inputs amortize it (and JSC built-ins are themselves
 * native). This script measures both paths across a size sweep with the same
 * methodology as bench-ffi.ts (median of interleaved trials + Bun.gc()) and
 * prints the crossover, which feeds the `SIZE_GATES` table in selection.ts.
 *
 *   bun scripts/bench-size-crossover.ts            # all gated candidates
 *   bun scripts/bench-size-crossover.ts hmacSha256 # one op
 *
 * Re-run after major Bun/castrum upgrades and update SIZE_GATES accordingly.
 */
import { fnv1a64Fallback } from "../packages/native/src/hash";
import { jsonValid } from "../packages/native/src/json";
import { nativeFor, useNative, warmRuntime } from "../packages/native/src/runtime";
import type { OpName } from "../packages/native/src/selection";

const TRIALS = 5;
const ITERS = 2_000;
const SIZES = [0, 32, 64, 128, 256, 512, 1024, 4096, 16_384, 65_536, 262_144];

const median = (nums: number[]): number => {
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
};

/** Median ns/op for `fn` over interleaved trials (noise-stable like bench-ffi). */
function bench(fn: () => unknown): number {
  const samples: number[] = [];
  Bun.gc(true);
  for (let t = 0; t < TRIALS; t++) {
    const start = performance.now();
    for (let i = 0; i < ITERS; i++) fn();
    samples.push(((performance.now() - start) * 1e6) / ITERS);
    Bun.gc(false);
  }
  return median(samples);
}

type Candidate = {
  op: OpName;
  /** The JS/Bun fallback timing thunk at size n. */
  js: (n: number) => () => unknown;
  /** The native timing thunk at size n (null when the op lacks a native path). */
  native: ((n: number) => () => unknown) | null;
};

const key = new Uint8Array(32).fill(7);

const candidates: Candidate[] = [
  {
    op: "hmacSha256",
    js: (n) => () => {
      const hasher = new Bun.CryptoHasher("sha256", key);
      hasher.update(new Uint8Array(n));
      hasher.digest("hex");
    },
    native: (n) => () => {
      const nv = nativeFor("hmacSha256");
      if (!nv) throw new Error("hmacSha256: native unavailable");
      return nv.hmacSha256(key, new Uint8Array(n));
    },
  },
  {
    op: "jsonValid",
    js: (n) => () => {
      const s = `{"a":${1},"pad":"${"x".repeat(Math.max(0, n - 12))}"}`;
      try {
        JSON.parse(s);
        return true;
      } catch {
        return false;
      }
    },
    native: (n) => () => jsonValid(`{"a":${1},"pad":"${"x".repeat(Math.max(0, n - 12))}"}`),
  },
  {
    op: "fnv1a64",
    js: (n) => () => fnv1a64Fallback(new Uint8Array(n)),
    native: (n) => () => {
      const nv = nativeFor("fnv1a64");
      if (!nv) throw new Error("fnv1a64: native unavailable");
      return nv.fnv1a64(new Uint8Array(n));
    },
  },
  {
    op: "gzipCompress",
    js: (n) => () => Bun.gzipSync(new Uint8Array(n)),
    native: null, // measured below via zlib-vs-bun only when native exists
  },
];

// gzip: compare Bun.gzipSync (the current "js" winner) against castrum's addon.
function gzipNativeBench(n: number): (() => unknown) | null {
  const nv = nativeFor("gzipCompress");
  if (!nv) return null;
  return () => nv.gzipCompress(new Uint8Array(n), 6);
}

function main(): void {
  warmRuntime();
  const only = process.argv[2];
  console.log(
    `size-crossover calibration (median of ${TRIALS} interleaved trials × ${ITERS} iters)\n`,
  );
  for (const c of candidates) {
    if (only && c.op !== only) continue;
    if (!useNative(c.op) && !nativeFor(c.op)) {
      console.log(`${c.op}: native unavailable — skipped`);
      continue;
    }
    console.log(`── ${c.op} ──`);
    let crossover: number | null = null;
    for (const size of SIZES) {
      const jns = bench(c.js(size));
      let nns: number;
      if (c.native) nns = bench(c.native(size));
      else {
        const nf = gzipNativeBench(size);
        if (!nf) {
          console.log("  gzip: no native addon — skipped");
          return;
        }
        nns = bench(nf);
      }
      const winner = nns < jns ? "native" : "js";
      if (winner === "native" && crossover === null && size > 0) crossover = size;
      console.log(
        `  ${String(size).padStart(7)}B  js ${jns.toFixed(0).padStart(8)}ns  ` +
          `native ${nns.toFixed(0).padStart(8)}ns  → ${winner}` +
          `  (${(jns / nns).toFixed(2)}x)`,
      );
    }
    console.log(
      crossover !== null
        ? `  → native wins from ~${crossover}B\n`
        : `  → js wins at every measured size\n`,
    );
  }
}

main();
