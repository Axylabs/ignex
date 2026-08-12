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

## Round 3 — plugin-cost breakdown + pre-baking plugin policies into Rust (2026-08-12)

### Where the ~0.7 ms plugin overhead actually goes (native, /health, isolated)
Measured by varying the plugin set in `packages/app/src/app.config.ts` (the
`0.33 ms` baseline already includes the i18n lifecycle middleware):

| Config | p50 | Δ |
| --- | --- | --- |
| core only (`plugins: []`) + i18n lifecycle | 0.33 ms | — |
| + `cors()` + `security()` | 0.52 ms | +0.19 ms |
| + `compression()` (alone) | 0.57 ms | +0.24 ms |
| full (cors, compression, security, session, native-preflight) | ~1.0 ms | session ≈ +0.25 ms |

**Key finding:** castrum's OK-path headers are *already* frozen pre-baked
templates (32 header-variant templates selected by the Rust `headerVariant`
bitmask — `src/ingress/headers/baked-templates.ts`). The `cors()`/`security()`
cost is therefore **JS lifecycle-hook dispatch + response re-wrapping**
(`reWrapResponse`/`appendVary`), **not header-string building**. Moving those
plugins into Rust would not remove the re-wrap cost until the pipeline exposes
its computed headers so the response can be assembled without a JS re-wrap.

### What moved into Rust (native terminal pre-bake)
- `createPipeline` (castrum) bakes security headers from
  **`runtime.securityHeaders`** into its terminal/error templates — not from
  `options.security` (that only drives the legacy `buildFastTemplates` path).
- Added a `runtime` pass-through to `@ignus/native` (`NativePipelineOptions`) and
  to `nativePreflight({ runtime })`, and configured the app to pre-bake
  `x-frame-options: DENY`, `x-content-type-options: nosniff`,
  `referrer-policy: no-referrer` at boot (`init()`).
- Result: when the pipeline terminates (CORS preflight, 429, 413, 400/422),
  the terminal response is served **fully from Rust** with the same security
  posture as the OK path, no JS lifecycle round-trip. Covered by a new test in
  `packages/native/test/native.test.ts` (asserts a castrum CORS-preflight 204
  carries the pre-baked security headers + echoed `access-control-allow-origin`).

### Honest limits of this approach
- The OK-path ~0.7 ms (session ≈0.25 ms, compression ≈0.24 ms, cors+security
  ≈0.19 ms) is lifecycle/re-wrap + session cookie work, so it does **not** move
  with the pipeline. The benchmark routes never hit a terminal response, so the
  bench numbers are unchanged (native ≈ 1.09 ms /health ≈ the committed 1.02 ms
  baseline — no regression; note the bench box thermal-throttles, absolute
  numbers varied 7–19K rps for identical code on 2026-08-12).
- ignus's own body-size 413 (`BODY_PARSE_ERROR`, `http/body.ts`) fires before the
  pipeline when `readBody:false`, so that path is not Rust-served yet.
- Castrum's baked OK templates do not emit `access-control-allow-origin` (it is
  added dynamically per request on terminal CORS via `responseHeaders`). Moving
  the OK-path CORS header emission into Rust still requires a castrum change;
  the JS `cors()` plugin remains the OK-path source of truth.

### Next steps (documented, not yet done)
1. Compare castrum `fast_schema` vs the compiled precompiled-ajv validator on the
   real 80-lineItem order body before wiring schema into the pipeline.
2. Expose parsed cookies / pipeline decisions in `PipelineResult` to cut the
   session plugin's ~0.25 ms per-request cookie work.
3. Move the body-size guard into the pipeline (or share `content-length` checks)
   so 413s come from Rust with the pre-baked security headers.

## Round 3.5 — follow-up results + the happy-path win (2026-08-12, later)

### Follow-up #1 (session) — DONE: lazy session creation, the biggest lever
The ~0.25 ms "session" cost was **eager session creation**: with
`createIfMissing: true`, every request without a `sid` cookie ran
`randomToken(16)` + `signCookie(JSON.stringify(...))` and wrote a `Set-Cookie`
header — on health checks, static routes and APIs that never use a session.
Measured on the bench this is pure redundant work (id generation + signing +
string allocations per request = GC pressure).

Fix (`packages/core/src/security/session.ts` + plugin):
- New `createIfMissing: "lazy"` mode: the middleware only `load()`s; creation
  is deferred until a handler actually reads the session via `getSession(ctx)`
  (which is now `async` and creates on first read). Requests that never touch a
  session do **zero** session work — no id, no signing, no `Set-Cookie`.
- `rolling: false` in the app config: a request that merely *carries* a valid
  session no longer re-signs + rewrites the cookie every time (the cookie is
  only rewritten when the handler mutates + saves the session).
- App config now `session({ secret, createIfMissing: "lazy", rolling: false })`.

Measured (native, `/health`, isolated, full plugin stack):
**1.09 ms → 0.76 ms p50** (~30% on the happy path) — the eager-create + rolling
re-sign on every request was the dominant remaining per-request cost. Backwards
compatible: `true`/`false` behave exactly as before; the `/session` smoke flow
(create on first visit, increment visits) passes unchanged. 779/779 vitest,
smoke 44/44 (native + fallback).

### Follow-up #2 (schema) — measured, DO NOT wire schema into the pipeline
`precompiled standalone Ajv` (the compiler's approach, `dist/validators/_h2.body.cjs`)
= **3.6 µs** vs castrum `fast_schema` = **27.6 µs** on the real 80-lineItem order
body — precompiled Ajv is **7.7× faster**. The Round-2 "fast_schema 2.3× win"
was only against *runtime* Ajv (87 µs). Wiring the schema into the pipeline
would save <0.2% of `/api/orders` (2.8 ms) and requires a compiler change to
pass per-route schemas to the (global) pipeline. **Keep precompiled Ajv.**

### Follow-up #3 (body guard) — closed in JS, NOT in the pipeline
The pipeline has a single `maxBodyBytes` but ignus has per-body-type limits
(JSON/text/form 2 MB, files 20 MB) — a global pipeline guard would break
`/upload`. The "413 lacks security headers" gap is instead closed at the
framework error envelope: `platform/errors.ts` `JSON_HEADERS` now always carries
`x-frame-options: DENY`, `x-content-type-options: nosniff`,
`referrer-policy: no-referrer`, so **every** error response (413/400/422/429/
500/…) matches the OK path + the Rust terminal templates. Verified: a 413 now
returns all three headers in both native and fallback modes.

### Context that reshaped the plan
- The native pre-flight bridge (`preprocess`) costs only **~1.2 µs/request**
  (micro-bench vs 0.08 µs baseline) — it was *not* part of the ~0.48 ms
  full-vs-core delta; that delta was compression (0.24) + eager session (0.24).
- The remaining happy-path cost is compression (~0.24 ms, already fixed once)
  and the lifecycle hook dispatch / response re-wrap itself.
