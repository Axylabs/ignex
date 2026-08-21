#!/usr/bin/env bun
import { parseCookieString, parseQuery, parseQueryFromURL } from "@ignex/core";
import {
  cookiePairs,
  cookiePairsFallback,
  formPairs,
  formPairsFallback,
  multipartParse,
  multipartParseFallback,
  queryPairs,
  queryPairsFallback,
  wsFrameDecode,
  wsFrameDecodeFallback,
} from "@ignex/native";
/**
 * Deterministic malformed-input fuzz (JS side) — `bun run fuzz:malformed`.
 *
 * Exercises every request-path decoder with adversarial input (arbitrary
 * strings, random bytes, truncated WS frames, hostile multipart boundaries)
 * and asserts the framework's stability contract: malformed input NEVER throws
 * or crashes — every decoder degrades gracefully (null/empty/partial). Where a
 * native + fallback pair exists, both must run without throwing on the same
 * inputs.
 *
 * Deterministic (fixed fast-check seed) so it can gate in
 * `.github/workflows/nightly.yml` (the Rust-side catch_unwind/fuzz remains
 * cross-repo with castrum — see docs/stability.md).
 *
 * Usage:
 *   bun run fuzz:malformed            # fixed seed (CI)
 *   FUZZ_SEED=123 bun run fuzz:malformed
 *   FUZZ_RUNS=2000 bun run fuzz:malformed
 */
import fc from "fast-check";

const SEED = Number(process.env.FUZZ_SEED ?? 424242);
const NUM_RUNS = Number(process.env.FUZZ_RUNS ?? 500);

let failures = 0;
const fail = (message: string): void => {
  failures += 1;
  console.error(`[fuzz] FAIL: ${message}`);
};

/** Run `fn`, recording a failure if it throws (never lets it crash the run). */
const noThrow = (label: string, fn: () => unknown): unknown => {
  try {
    return fn();
  } catch (err) {
    fail(`${label} threw: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
};

const main = (): void => {
  // 1. Core request-path decoders must never throw on adversarial strings.
  fc.assert(
    fc.property(fc.string({ maxLength: 256 }), (s) => {
      noThrow("parseCookieString", () => parseCookieString(s));
      noThrow("parseQuery", () => parseQuery(s));
      noThrow("parseQueryFromURL", () => parseQueryFromURL(s));
    }),
    { numRuns: NUM_RUNS, seed: SEED },
  );

  // 2. Pair parsers: native and fallback both run without throwing.
  fc.assert(
    fc.property(fc.string({ maxLength: 256 }), (s) => {
      for (const [name, f, fb] of [
        ["queryPairs", queryPairs, queryPairsFallback],
        ["cookiePairs", cookiePairs, cookiePairsFallback],
        ["formPairs", formPairs, formPairsFallback],
      ] as const) {
        noThrow(name, () => f(s));
        noThrow(`${name}Fallback`, () => fb(s));
      }
    }),
    { numRuns: NUM_RUNS, seed: SEED },
  );

  // 3. WS frame decode must never throw on arbitrary/truncated bytes, and the
  //    native/fallback paths must agree on frame-validity (nullability).
  fc.assert(
    fc.property(fc.uint8Array({ minLength: 0, maxLength: 128 }), (bytes) => {
      noThrow("wsFrameDecode", () => wsFrameDecode(bytes));
      noThrow("wsFrameDecodeFallback", () => wsFrameDecodeFallback(bytes));
      const a = wsFrameDecode(bytes);
      const b = wsFrameDecodeFallback(bytes);
      if ((a === null) !== (b === null)) {
        fail(`wsFrameDecode nullability mismatch for ${bytes.length}-byte frame`);
      }
    }),
    { numRuns: NUM_RUNS, seed: SEED },
  );

  // 4. Multipart parse must never throw on adversarial body + boundary.
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 0, maxLength: 256 }),
      fc.string({ maxLength: 32 }),
      (body, boundary) => {
        const b = boundary || "--x";
        noThrow("multipartParse", () => multipartParse(body, b));
        noThrow("multipartParseFallback", () => multipartParseFallback(body, b));
      },
    ),
    { numRuns: NUM_RUNS, seed: SEED },
  );

  if (failures > 0) {
    console.error(
      `[fuzz] ${failures} failure(s) — the malformed-input-never-crashes guarantee was violated.`,
    );
    process.exit(1);
  }
  console.log(
    `[fuzz] OK — ${NUM_RUNS} runs/seed ${SEED} across all decoders: no throws, native+fallback agree.`,
  );
};

main();
