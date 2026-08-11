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
