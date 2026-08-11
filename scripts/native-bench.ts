#!/usr/bin/env bun
/**
 * Native-vs-fallback micro-benchmark for the primitives wired into
 * `@ignus/core` through `@ignus/native`.
 *
 *   bun scripts/native-bench.ts            # fallback-only (no addon) baseline
 *   IGNUS_NATIVE_PATH=... bun scripts/native-bench.ts   # real-addon comparison
 *
 * When the Rust addon is unavailable the script reports the pure-TS baseline
 * and skips the comparison (parity, not performance, is guaranteed there).
 */
import {
  cookiePairs,
  cookiePairsFallback,
  createConditionalRequest,
  createConditionalRequestFallback,
  createSchemaValidator,
  etag,
  etagFallback,
  fnv1a64,
  fnv1a64Fallback,
  formPairs,
  formPairsFallback,
  isNativeAvailable,
  queryPairs,
  queryPairsFallback,
  sseEncode,
  sseEncodeFallback,
  validateEmail,
  validateIpv4,
  validateUuid,
} from "../packages/native/src/index";

const MODE = isNativeAvailable() ? "NATIVE" : "FALLBACK";
console.log(
  `mode: ${MODE}${MODE === "FALLBACK" ? " (castrum addon not loaded — baseline only)" : ""}\n`,
);

// Sample inputs — LARGE inputs so the adaptive native path (≥128 bytes)
// engages and the Rust win is visible. Tiny inputs deliberately stay on the
// fast JS fallback (FFI does not amortize below the threshold).
const bigChunk = "x".repeat(64);
const body = `name=Ada%20Lovelace&role=engineer&active=true&tags=a&tags=b&lang=en&chunk=${bigChunk}`;
const cookies = Array.from({ length: 12 }, (_, i) => `k${i}=v${bigChunk.slice(0, 40)};`).join(" ");
const query = `page=2&sort=asc&filter=price&filter=stock&chunk=${bigChunk}&q=${bigChunk}`;
const schema = JSON.stringify({
  type: "object",
  properties: { id: { type: "number" }, name: { type: "string" } },
  required: ["id", "name"],
});
const doc = JSON.stringify({ id: 1, name: "widget" });
const etagInput = `hello world, this is an etag sample ${bigChunk}`;
const sseData = `line0 ${bigChunk}\nline1 ${bigChunk}`;

const enc = new TextEncoder();

/** Measure ops/sec for a synchronous fn (warmup + timed loop). */
function opsPerSec(fn: () => void, durationMs = 250): number {
  for (let i = 0; i < 1_000; i++) fn(); // warmup
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

function report(name: string, native: () => void, fallback: () => void): void {
  const n = opsPerSec(native);
  const f = opsPerSec(fallback);
  const ratio = n > 0 && f > 0 ? n / f : Number.NaN;
  const ratioText = Number.isFinite(ratio) ? ` (native x${ratio.toFixed(2)})` : "";
  console.log(
    `${name.padEnd(26)} native ${String(Math.round(n)).padStart(9)} ops/s | fallback ${String(
      Math.round(f),
    ).padStart(9)} ops/s${ratioText}`,
  );
}

report(
  "fnv1a64",
  () => fnv1a64(etagInput),
  () => fnv1a64Fallback(enc.encode(etagInput)),
);
report(
  "queryPairs",
  () => queryPairs(query),
  () => queryPairsFallback(enc.encode(query)),
);
report(
  "cookiePairs",
  () => cookiePairs(cookies),
  () => cookiePairsFallback(enc.encode(cookies)),
);
report(
  "formPairs",
  () => formPairs(body),
  () => formPairsFallback(enc.encode(body)),
);
report(
  "etag",
  () => etag(etagInput),
  () => etagFallback(enc.encode(etagInput), false),
);
report(
  "conditional",
  () => createConditionalRequest('"abc123"', 1_700_000_000).isNotModified('"abc123"'),
  () => createConditionalRequestFallback('"abc123"', 1_700_000_000).isNotModified('"abc123"'),
);
report(
  "validateEmail",
  () => validateEmail("ada@example.com"),
  () => validateEmail("ada@example.com"),
);
report(
  "validateUuid",
  () => validateUuid("123e4567-e89b-12d3-a456-426614174000"),
  () => validateUuid("123e4567-e89b-12d3-a456-426614174000"),
);
report(
  "validateIpv4",
  () => validateIpv4("192.168.0.1"),
  () => validateIpv4("192.168.0.1"),
);
report(
  "sseEncode",
  () => sseEncode("message", sseData, "42"),
  () => sseEncodeFallback("message", sseData, "42", null),
);

const validator = createSchemaValidator(schema);
if (validator) {
  const n = opsPerSec(() => validator.validate(doc));
  console.log(`${`schemaValidate`.padEnd(26)} native ${String(Math.round(n)).padStart(9)} ops/s`);
} else {
  console.log("schemaValidate native: unavailable (null bridge) — core keeps Ajv.");
}

if (MODE === "NATIVE") {
  console.log("\nNative loaded — ratios above show the win (bigger = faster).");
} else {
  console.log("\nInstall/build castrum and set IGNUS_NATIVE_PATH to compare native vs fallback.");
}
