#!/usr/bin/env bun
/**
 * Per-route native stack vs JS prelude benchmark.
 *
 * Measures EXACTLY what the compiled core fn does per request on a
 * query/cookie-validated route:
 *   JS      : parseQueryFromURL(req.url) + parseCookieString(cookie)
 *   native  : slice query → pack frame → createNativeRoute(...).run(frame)
 *             → groupQueryPairs(__nr.query) + cookiePairsToRecord(__nr.cookie)
 *
 * This is the headline question for the feature: does the ONE pre-baked native
 * call (parse in Rust, results decoded once) beat the JS split/decode parsers
 * for realistic query/cookie inputs? Median of interleaved trials with Bun.gc
 * (the bench-ffi.ts / bench-native.ts methodology).
 *
 *   IGNEX_NATIVE_PATH=/path/to/castrum.linux-x64-gnu.node bun scripts/bench-native-route.ts
 * Exits 0 (no native surface → skip) and prints a native/JS ratio table.
 */
import { groupQueryPairs, parseQueryFromURL } from "../packages/core/src/data/query";
import { cookiePairsToRecord, parseCookieString } from "../packages/core/src/http/cookies";
import { createNativeRoute } from "../packages/native/src/route";

const route = createNativeRoute({
  pipeline: ["parseQuery", "parseCookies"],
  schemas: {},
  maxBodyBytes: 2 * 1024 * 1024,
  maxQueryBytes: 1024 * 1024,
  maxCookieBytes: 8192,
  maxPairs: 0,
});

if (route === null) {
  console.log("route surface unavailable (no addon/route module) — nothing to bench.");
  process.exit(0);
}

// ── Inputs (realistic: a few params / cookies, some percent-encoded) ──
const QUERIES = [
  "a=1&b=hello%20world",
  "page=2&limit=20&q=shoes&sort=price",
  "id=123e4567-e89b-12d3-a456-426614174000&verbose=true",
  "k=%E2%9C%93&p=a+b&q=one%20two%20three",
];
const COOKIES = [
  "sid=abc123; theme=dark; locale=en-US",
  "session=9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08; csrf=abc",
  "a=1; b=2; c=3; d=4",
];
// Large inputs (filter/query-string heavy) — does the crossing amortize?
const BIG_QUERY = Array.from({ length: 60 }, (_, i) => `f${i}=${"x".repeat(12)}`).join("&");
const BIG_COOKIE = Array.from({ length: 30 }, (_, i) => `c${i}=${"y".repeat(20)}`).join("; ");

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

function opsPerSec(fn: () => void, durationMs = 100, warmup = 200): number {
  for (let i = 0; i < warmup; i++) fn();
  const start = performance.now();
  let count = 0;
  while (performance.now() - start < durationMs) {
    fn();
    count++;
  }
  return count / ((performance.now() - start) / 1000);
}

const TRIALS = 5;
const urlFor = (q: string): string => `http://localhost:3000/api/search?${q}`;

// The JS prelude exactly as emitted (parseQueryFromURL slices `?` itself).
const jsQuery = (q: string): unknown => parseQueryFromURL(urlFor(q));
const jsCookie = (c: string): unknown => parseCookieString(c);
const jsBoth = (q: string, c: string): void => {
  parseQueryFromURL(urlFor(q));
  parseCookieString(c);
};

const nativeQuery = (q: string): unknown => {
  const r = route.run({ query: q, cookie: "", body: null });
  return groupQueryPairs(r.query);
};
const nativeCookie = (c: string): unknown => {
  const r = route.run({ query: "", cookie: c, body: null });
  return cookiePairsToRecord(r.cookie);
};
const nativeBoth = (q: string, c: string): void => {
  const r = route.run({ query: q, cookie: c, body: null });
  groupQueryPairs(r.query);
  cookiePairsToRecord(r.cookie);
};

function bench(name: string, native: () => unknown, js: () => unknown): void {
  // Sanity: identical output (parity) before measuring.
  let nativeOut: unknown;
  let jsOut: unknown;
  try {
    nativeOut = native();
    jsOut = js();
  } catch (e) {
    console.log(`SKIP ${name}: threw (${(e as Error).message})`);
    return;
  }
  const nJson = JSON.stringify(nativeOut);
  const jJson = JSON.stringify(jsOut);
  if (nJson !== jJson) {
    console.log(`SKIP ${name}: parity mismatch (native=${nJson} js=${jJson})`);
    return;
  }

  const nSamples: number[] = [];
  const jSamples: number[] = [];
  for (let t = 0; t < TRIALS; t++) {
    Bun.gc(true);
    nSamples.push(opsPerSec(() => native()));
    Bun.gc(true);
    jSamples.push(opsPerSec(() => js()));
  }
  const n = median(nSamples);
  const j = median(jSamples);
  const ratio = n / j;
  console.log(
    `${name.padEnd(28)} native ${n.toFixed(0).padStart(9)}  js ${j.toFixed(0).padStart(9)}  native/JS ${ratio.toFixed(2)}x${ratio >= 1.05 ? "  ✓" : ratio <= 0.95 ? "  ✗" : ""}`,
  );
}

console.log(`per-route native stack vs JS prelude (median of ${TRIALS} interleaved trials):\n`);
for (const q of QUERIES)
  bench(
    `query ${JSON.stringify(q.slice(0, 24))}…`,
    () => nativeQuery(q),
    () => jsQuery(q),
  );
for (const c of COOKIES)
  bench(
    `cookie ${JSON.stringify(c.slice(0, 24))}…`,
    () => nativeCookie(c),
    () => jsCookie(c),
  );
for (let i = 0; i < Math.min(QUERIES.length, COOKIES.length); i++) {
  bench(
    "query+cookie combined",
    () => nativeBoth(QUERIES[i] as string, COOKIES[i] as string),
    () => jsBoth(QUERIES[i] as string, COOKIES[i] as string),
  );
}
console.log("\nlarge inputs (amortization check):");
bench(
  `BIG query (${BIG_QUERY.length}B)`,
  () => nativeQuery(BIG_QUERY),
  () => jsQuery(BIG_QUERY),
);
bench(
  `BIG cookie (${BIG_COOKIE.length}B)`,
  () => nativeCookie(BIG_COOKIE),
  () => jsCookie(BIG_COOKIE),
);
bench(
  "BIG query+cookie",
  () => nativeBoth(BIG_QUERY, BIG_COOKIE),
  () => jsBoth(BIG_QUERY, BIG_COOKIE),
);

route.destroy();
