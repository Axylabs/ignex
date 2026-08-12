# Performance baseline — 2026-08-11

Evidence captured at the start of the "native acceleration at scale" pass. Used as the
regression baseline for the CI bench gate and to decide which native paths to wire.

## Environment

- OS: Linux x86-64; Bun (workspace engines `bun >=1.4`); Node-API addon `castrum@0.8.0`.
- `isNativeAvailable()` in this dev environment: **`true`** — the rebuilt castrum addon
  loads under Bun. Real-native e2e is in scope locally.
- Addon binary: `bun-rust-runtime-bench/castrum.linux-x64-gnu.node` (built 2026-08-11).
- Castrum rebuild (`bun --cwd bun-rust-runtime-bench run build`): exit 0, incremental
  no-op when sources are unchanged.

## Static gates

| Gate | Result |
| --- | --- |
| Root typecheck (`tsc --noEmit`) | PASS (0 errors) |
| CLI typecheck (`tsc -p packages/cli/tsconfig.json`) | PASS (0 errors) |
| `oxlint .` | PASS (0 issues) |
| `biome check .` | PASS — 0 errors, 56 warnings (accepted baseline) |
| App build (`bun --cwd packages/app build`) | PASS — 119.6 ms, `dist/__server.js` (317.8 KB) |
| Smoke (`bun scripts/smoke.ts`) | PASS — /health /hello /products/123 /missing-route 4/4 |

## Tests

| Metric | Value |
| --- | --- |
| Test files | 42 |
| Tests | 548 passed (548) |
| Duration | 5.58 s |

## Coverage (v8, thresholds lines 60 / fns 50 / stmts 55 / branches 40)

| Metric | Value | Threshold |
| --- | --- | --- |
| Statements | 67.11% (4028/6002) | 55 |
| Branches | 56.62% (2371/4187) | 40 |
| Functions | 71.62% (775/1082) | 50 |
| Lines | 69.35% (3669/5290) | 60 |

## Native micro-benchmark (`bun scripts/native-bench.ts`, real addon loaded)

Large inputs (≥128 bytes) so the adaptive native path engages. `ratio = native/fallback`.

| Op | native ops/s | fallback ops/s | ratio |
| --- | --- | --- | --- |
| fnv1a64 | 624,468 | 92,664 | **x6.74** |
| queryPairs | 124,597 | 130,209 | x0.96 |
| cookiePairs | 148,954 | 229,880 | x0.65 |
| formPairs | 147,272 | 167,735 | x0.88 |
| etag | 1,305,249 | 1,423,383 | x0.92 |
| conditional | 3,924,918 | 3,450,073 | x1.14 |
| validateEmail | 764,783 | 760,963 | x1.01 |
| validateUuid | 816,924 | 685,125 | x1.19 |
| validateIpv4 | 759,097 | 745,670 | x1.02 |
| sseEncode | 1,344,462 | 1,087,561 | x1.24 |
| schemaValidate | 512,027 (native only) | — | — |

### Notes (differs from the older `docs/native-acceleration.md` "measured" section)

- Several ops previously classed as "deliberately pure-TS (native slower via FFI)" are now
  **at parity or better** with the current addon on large inputs: `conditional` x1.14,
  `sseEncode` x1.24, `validateUuid` x1.19. Revisit those wiring decisions (results-driven).
- `cookiePairs` x0.65, `formPairs` x0.88, `etag` x0.92, `queryPairs` x0.96 — JS still wins,
  but only marginally (the old doc claimed 2–5x). Scalar FFI remains the wrong path for these;
  batched/packed native (e.g. `queryParseBatchPacked`, `crc32BatchPacked`) is the at-scale lever.
- `fnv1a64` native x6.74 — already wired and confirmed.

## Priorities this informs

1. Batch/coalesced native + the one-FFI-per-request ingress pipeline are the at-scale levers.
2. Wire native `multipartParse`, packed parsers for large inputs, `jsonValid` pre-check, and
   `SchemaValidator` for large schemas (all proven-fast, currently unwired).
3. Standalone native `RateLimiter` (from `rust/ingress/rate_limit.rs`) + core `rateLimit`
   bridge — per-request fixed-window state in Rust.
4. Re-measure after each wiring to keep the matrix honest.

## End-to-end compiled-server benchmark (`bun run bench:server`) — 2026-08-12

A repeatable, interleaved median-of-3 HTTP load bench of the **AOT-compiled**
`packages/app/dist/__server.js` (native-on vs `IGNUS_NATIVE=off`), reporting
per-route req/s + p50/p95/p99. Results in `bench/results/server/{latest,<ts>}.json`.
Methodology: modes are interleaved (alternating which runs first) and the reported
numbers are the median across repeats — this cancels the order/thermal noise that
made naive single-run A/B readings meaningless on a laptop (one-off runs showed
fake "native −20%" and "−2.9x" results).

**After Phase 1 wiring (preflight pipeline as default stage + body-guard + i18n):
native ≈ fallback.** Representative medians (DURATION=3, WARMUP=1, CONCURRENCY=32):

| Route | native rps | fallback rps | rps ratio | native p50 | fallback p50 |
| --- | --- | --- | --- | --- | --- |
| GET /health | 841.7 | 858.0 | 0.98 | 5.23ms | 5.24ms |
| GET / (constant) | 843.3 | 857.7 | 0.98 | 5.14ms | 5.08ms |
| GET /products/123 | 838.3 | 859.0 | 0.98 | 5.29ms | 5.37ms |
| GET /i18n (es) | 837.3 | 860.3 | 0.97 | 5.28ms | 5.31ms |
| GET /page (template) | 838.3 | 862.0 | 0.97 | 8.09ms | 8.09ms |
| POST /products/add | 839.7 | 863.3 | 0.97 | 5.03ms | 5.23ms |

Takeaway: the compiled server (Bun native router + precompiled standalone
validators + `fast-json-stringify` serializers + JS-wins selections) is already
near-optimal; the native layer runs at parity and adds per-request native
enforcement (URL/header limits) for free. The remaining per-request CPU work that
is still pure JS is **off this benchmark's radar** (interpreted-path runtime Ajv,
opt-in pino access-log, scalar pair parsing that JS wins). See
`docs/native-acceleration.md` (2026-08-12 section) for the measured gate
decisions on those.

## Deep-dive: real-workload vs a raw Bun.serve baseline — 2026-08-12 (later)

Why the trivial-route bench hid the real costs. A new **raw-Bun baseline**
(`bench/servers/raw-bun-server.ts`, plain `Bun.serve` doing the same work) and
**6 real-data routes** (bulk JSON+schema, 60-param query, 30 cookies+session,
HS256 JWT, 120-item template, 256KB gzip) were added, measured **per-route
isolated** (`scripts/bench-server-routes.ts`) so routes don't throttle each other
(a round-robin client gets flattened by the heaviest route).

### Findings (all measured)

1. **Core ignus runtime ≈ raw-Bun.** With no plugins, `/health` = 62K rps
   (0.33ms) vs raw-Bun 85K (0.25ms) — the framework core is 1.36× of raw Bun.
2. **The compression plugin was the dominant cost.** Bun sets **no
   `content-length`** on any `Response`, so the plugin's `threshold` pre-check
   never fired and EVERY response (even a 36-byte `/health`) was buffered +
   compressed; under concurrency that path cost **~2.3ms/request** (gzip + re-wrap
   on the single event-loop core). Isolated micro-bench: `Bun.gzipSync(36B)` is
   7.5µs — the cost is the re-wrapped-response path, not the gzip math.
3. **Fix:** buffer once, apply the threshold on the REAL size, skip tiny bodies,
   set `content-length`. `/health` 3.16ms → 1.02ms.
4. **Rust is at parity, not "underperforming":** native ≈ fallback on every route.
   The pipeline (Rust ingress, no configured stages) measures ~0ms overhead. The
   compiled server's per-request cost is dominated by Bun-side work (compression,
   JSON.parse, plugins) that Rust cannot beat through FFI, plus a ~0.7ms plugin
   overhead (compression re-wrap ~0.24 + cors/security/session/i18n ~0.45).
5. **Static-content routes were CPU-bound under concurrency** (minijinja render +
   per-request gzip serialize on one core); raw-Bun won by precomputing. Fix:
   compile-once + precompress (`/catalog`, `/api/big`).

### Post-fix per-route (native, 24 conn, isolated; ratio = native/raw-Bun)

| Route | raw-Bun rps (p50) | native rps (p50) | ratio |
| --- | --- | --- | --- |
| GET /health | 84,678 (0.25ms) | 16,968 (1.19ms) | 0.20 |
| POST /api/orders (bulk JSON+schema) | 18,003 (1.19ms) | 7,377 (2.83ms) | 0.41 |
| GET /api/search (60 params) | 17,316 (1.24ms) | 8,886 (2.26ms) | 0.51 |
| GET /api/me (30 cookies+sess) | 43,902 (0.45ms) | 10,059 (2.04ms) | 0.23 |
| GET /api/reports/42 (JWT) | 57,684 (0.34ms) | 16,127 (1.23ms) | 0.28 |
| GET /catalog (120-item template) | 23,612 (0.84ms) | 19,170 (0.99ms) | **0.81** |
| GET /api/big (256KB gzip) | 4,479 (5.32ms) | 3,885 (5.89ms) | **0.87** |

- Static-content routes (catalog, big) went from 0.04–0.08× → **0.81–0.87×**
  (precompute pattern). All dynamic routes improved 2–4× from the compression fix.
- The remaining dynamic-route gap is the **~0.7ms framework overhead** (plugins) +
  real work; on `/api/orders` castrum `fast_schema` validates the 80-lineItem
  body in **38µs vs runtime-ajv 87µs (2.3×)**, but the compiled server uses a
  precompiled standalone ajv validator, so the wire-in needs a precompiled-vs-
  fast_schema comparison before committing to it.
