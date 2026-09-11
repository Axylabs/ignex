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
`packages/app/dist/__server.js` (native-on vs `IGNEX_NATIVE=off`), reporting
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

1. **Core ignex runtime ≈ raw-Bun.** With no plugins, `/health` = 62K rps
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
- Added a `runtime` pass-through to `@ignex/native` (`NativePipelineOptions`) and
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
- ignex's own body-size 413 (`BODY_PARSE_ERROR`, `http/body.ts`) fires before the
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
The pipeline has a single `maxBodyBytes` but ignex has per-body-type limits
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

## Round 4 — Elysia-informed per-request allocation pass (2026-08-13)

Pass informed by studying the Elysia source (`/home/adeel/poc/elysia`): the
edge that matters for us is *eliminating per-request allocations in the JS
hot path*, not more native micro-tuning (Rust is already <1% of per-request
cost). Changes landed across BOTH repos:

### castrum (this workspace) — `src/ingress/`
1. **Body fast path** (`body.ts`): when a declared `Content-Length` proves the
   body fits the guard, read with a single native `req.arrayBuffer()` (one race
   for the deadline, not one per chunk) instead of reader + per-chunk
   `Promise.race` + `concatUint8Arrays`. Removes ~4-6 allocations per write
   request (bench POSTs are single-shot bodies). Post-read length re-check
   catches a client that lies about `Content-Length`; `arrayBuffer()` is bounded
   by the server `maxRequestBodySize`.
2. **Hoisted route closures** (`routes/read|head|fallback.ts`): the
   `result → Response` callback is built once per handler, not per request.
   `terminalResponse`/`errorResponse` `req` params made optional (they were
   already unused — back-compatible).
3. Tests added in `test/unit/ingress/body.test.ts` (fast path + declared-length
   413 short-circuit). Typecheck clean; 580 TS tests pass; `bench:http:smoke`
   gate green (0 shape failures).

### ignex — `packages/core/src/plugins/`
1. **CORS no-Origin fast path** (`cors.ts`): `onResponse` now returns the
   *identical* Response object when the request has no `Origin` header — zero
   `Headers` copy + zero re-wrap on the common path (matches express-cors:
   `Vary: Origin` only when an Origin is present). Origin-present behavior is
   unchanged. New test asserts the identity return.
2. **Security scheme check** (`security.ts`): `isHttpsRequest` reads the scheme
   from `ctx.req.url.startsWith("https:")` instead of materializing
   `new URL(req.url)` per response (an allocation + full parse on every request).

### Measurements
- **castrum `02-load` (sustained, ~120 s)** — same scenario/method as the
  08-12 run: p50 **0.590 ms (identical)**, p95 **1.877 → 0.886 ms**, p99
  **3.502 → 1.078 ms** (tails more than halved). Identical median + tighter
  tail is the signature of reduced per-request allocation/GC pressure.
  Single-run caveat applies (laptop noise), but p50 being stable strengthens
  the signal.
- **ignex interleaved A/B `/health`**: native ≈ fallback p50 0.85 ms (ratio
  1.00) — parity confirmed, no regression from the plugin changes.
- **ignex verify**: 780/780 vitest, typecheck + lint green. Biome now ignores
  `bench/results/` (generated benchmark JSON was failing the formatting gate).

### Deferred (documented follow-ups, not regressions)
- **Rust OUT-layout header-section emission**: extending the drift-guarded wire
  contract to return a pre-assembled OK-path header section from Rust. Rust is
  <1% of per-request cost and JS header assembly is already memoized (origin
  cache + frozen templates) — high contract risk, low ROI. Deferred.
- **Static-response promotion**: verified Bun re-serves prebuilt `Response`s
  passed directly as native `routes` values (Elysia's `collectStaticRoutes`),
  but the compiler's constant-hoist path only fires when the app has NO
  plugins (`tryNormalizeConstant` bails on global hooks), so it won't move the
  bench app. Pre-baking plugin headers (security/CORS) into static responses at
  build time is the real feature — larger, deferred.
- **Dynamic routing**: compiled ignex already handles `:param` via Bun's native
  router; the gap is castrum's static-only `createIngressServer(ServerNode)`
  and the interpreted `createApp` (no router). Feature-sized, deferred.
- **castrum lint debt (pre-existing)**: `src/ingress/` uses double quotes while
  `biome.json` declares single quotes — `bun run lint` was already red before
  this pass. Left untouched (matching repo style).

## Round 5 — Rust-strategy P1: content-length + zero-copy pipeline responses (2026-08-13)

Goal (from the Rust-strategy analysis): move hot-path + dev-touched code toward
native execution. Honest finding from grounding: castrum's pipeline is ALREADY
Rust (parse/guard/validate/serialize/rate/CORS); the remaining per-request wins
are structural JS around it — so P1 landed two verifiable slices.

### 1. ignex: reply builders emit `content-length` (`packages/compiler/src/phases/codegen/helpers.ts`)
- New `__withBody` codegen helper encodes a string body via `TextEncoder`
  (one pass) and sets an accurate `content-length`. `jsonReply`/`textReply`/
  `htmlReply` and `__finalize`'s serializer path go through it.
- **Why**: Bun only materializes `content-length` at serve time — the in-process
  `Response` object has it as `null` (probed), so the compression plugin always
  buffers a response just to learn its size when the client sends
  `accept-encoding` (browsers always do — this is the real production cost).
- Verified end-to-end: built server serves `/health` with `content-length: 36`
  and compression early-returns (no buffer, no `content-encoding`) under
  `accept-encoding: gzip`. Micro-bench: compression `onResponse` on a small
  response with gzip **2402 ns → 424 ns/req** (~2 µs saved/req).
- Gates: 780/780 vitest, 205/205 compiler tests (no golden-fixture churn),
  lint green, app smoke 44/44, interleaved bench native ≈ fallback (no
  regression).

### 2. castrum: zero-copy pipeline-only responses (safe by default in the bench)
- `handlers.ts`: added `BakedIngressRuntime.zeroCopyTimeoutMs` (abandonment
  guard) wired through `zeroCopyResponse` → `pooledBodyResponse`.
- `bench/servers/raw-bun-server.ts`: zero-copy is now ON by default, bounded by
  `INGRESS_ZERO_COPY_MAX_IN_FLIGHT=128` + `INGRESS_ZERO_COPY_TIMEOUT_MS=1000`;
  `INGRESS_ZERO_COPY=0` restores copy mode; legacy `INGRESS_UNSAFE_ZERO_COPY`
  kept as an alias. Removes the per-response `.slice()` body copy.
- Gates: 585/585 TS tests, `bench:http:smoke` green with zero-copy on, and the
  sustained `02-load` is safe (0 failures, 0 shape failures).

### Measured (castrum `02-load`, sustained ~120 s; cumulative vs the 08-12 baseline)
| metric | baseline | now | |
| --- | --- | --- | --- |
| p50 | 0.590 ms | 0.601 ms | pacing-limited, unchanged |
| p95 | 1.877 ms | **0.860 ms** | ~2.2× |
| p99 | 3.502 ms | **0.976 ms** | ~3.6× |
| p99.9 | 21.5 ms | **2.079 ms** | ~10× |

### Where "more Rust" is NOT the lever (evidence, from the strategy analysis)
- Small-payload validation: precompiled Ajv 3.6 µs vs `fast_schema` 27 µs — JS wins.
- Header assembly: Rust building header strings can't feed `new Response()`
  (conversion tax); the JS template + origin-cache memo is already near-zero-alloc.
- Arbitrary dev object serialization: JS→Rust marshaling makes native
  serialization non-viable; precompiled `fast-json-stringify` (JIT) is the tool.
- Ops where Bun built-ins beat FFI (`BUN_WINS`): crc32/gzip/HMAC.
- Dev handler/hook business logic: Bun JIT is excellent; embedding an engine
  adds net cost. The win is the framework AROUND dev code.

### Still deferred (documented follow-ups)
- **Pipeline-only native routes** in the compiler (whole lifecycle for a
  schema+serializer route in one Rust call, zero-copy wrap) — needs the
  wire-contract extension; the zero-copy + content-length slices above are the
  foundation it builds on.
- Static-response promotion with pre-baked plugin headers; dynamic routing for
  interpreted `createApp` + castrum Node adapter; Rust-owned session/rate state.

## Round 6 — eliminate the response re-wrap chain (in-place headers, 2026-08-13)

The P0 stage profile of the compiled server's JS path (after Rounds 4–5) showed
the per-request framework cost is dominated by **response re-wrapping**: each
plugin did `new Headers(response.headers)` + `new Response(response.body, ...)`.
Measured stage costs: security.onResponse ~2.5–3.9 µs, cors.onResponse no-origin
~0.35–1.7 µs, applySet re-wrap, total ~7.2 µs/req JS.

### The key probe
**Bun allows in-place mutation of a `Response`'s headers and reflects it on the
wire** — for locally-created responses AND fetched/proxied ones (probed
2026-08-13). The Fetch spec says immutable, but Bun is lenient; other runtimes
(undici) still throw, which drives the fallback.

### The change (`packages/core/src/http/headers.ts` + plugins)
- New **`mutateHeaders(response, fn)`** helper: applies header mutations to
  `response.headers` IN PLACE (no copy, no new Response, no body re-read) and
  returns the SAME response; falls back to the copy + re-wrap when the runtime
  enforces immutability (the `catch` re-applies `fn` on a copied `Headers`).
- **cors.onResponse**, **security.onResponse** now mutate in place.
- **applySet**: header/cookie-only mutations mutate in place; status changes /
  redirects still re-wrap (Response status is not mutable in place).
- Bonus: content-length (Round 5) now survives the WHOLE chain because nothing
  re-wraps — compression's early-return is never defeated by a re-wrap.

### Measured (micro-bench, same primitives as the P0 profile)
| Stage | before | after |
| --- | --- | --- |
| cors.onResponse (no-origin) | ~1.7 µs | **109 ns** |
| security.onResponse | ~3.9 µs | **898 ns** |
| applySet (set with a header) | re-wrap | **306 ns** (in-place) |

~5 µs/request of JS removed. Gates: 780/780 vitest, lint green, app smoke 44/44
(CORS actual + security headers verified on the in-place path). Interleaved
bench now shows native ahead of fallback on p50 (`/health` 1.31 vs 1.42 ms,
native ~8% faster — before this change it was fallback-leaning; absolute laptop
numbers remain noisy, the micro-bench is the reliable signal).

### Notes / remaining
- security.onResponse is still ~900 ns (8 header sets + HSTS check) — could be
  trimmed by pre-baking the static security header pairs once at plugin
  creation; modest.
- The compiled server's remaining per-request JS is createContext (~1.35 µs),
  async hook dispatch (~1.9 µs), and the reply builders — the natural target for
  the deferred pipeline-only-native-routes work.
- Non-Bun runtimes use the re-wrap fallback automatically (correct, just slower).

## Round 7 — skip empty lifecycle stages + pre-bake security headers (2026-08-13)

The Round 6 profile left two framework-side JS costs: per-request async hook
dispatch (several stages are EMPTY for most routes) and the security plugin's
per-request option re-evaluation.

### 1. Codegen: skip empty lifecycle stages (`packages/compiler/.../codegen/routes/`)
- `assembleCoreFn` (handler.ts) + the full-context prelude (context.ts) now guard
  every stage with a length check:
  `if (__lc.beforeHandle && __lc.beforeHandle.length > 0) { ... }` (and the same
  for route hooks, afterHandle, mapResponse, afterResponse, trace,
  `__preParseStages`).
- An empty `runHooks([], ctx)` costs ~250 ns (async fn + Promise + a fresh
  `{ctx}` result object + one microtask); the guarded skip costs ~69 ns — so
  ~180 ns saved per empty stage. `/health` has ~5 empty stages (beforeHandle,
  route hooks, mapResponse, afterResponse, trace) → ~0.9 µs/request.
- Semantics preserved: skipping a stage with no hooks is identical to running it
  (nothing can halt/change the ctx). Non-empty stages are untouched.

### 2. Security plugin: pre-bake static headers (`packages/core/src/plugins/security.ts`)
- The per-request-invariant security headers (CSP, COEP, COOP, CORP,
  X-Frame-Options, X-Content-Type-Options, Referrer-Policy, X-XSS-Protection)
  are baked into a frozen `[name, value][]` once at plugin creation; the
  per-response path iterates the array instead of re-evaluating every option +
  rebuilding each header string. Only HSTS (https-conditional) and the
  X-Powered-By delete stay per-request.

### Gates & measurements
- 780/780 vitest, 205/205 compiler tests (no golden-fixture churn), lint +
  typecheck green, app smoke 44/44 (security + CORS verified on the in-place
  path).
- Micro-bench: `runHooks(empty)` 250 ns → guarded-skip 69 ns; security
  pre-bake trims the per-response option/string work. Interleaved bench stays
  native ≈ fallback (0 errors); the bench box thermal-throttles (absolute p50
  drift documented in Round 3), so the micro-bench numbers are the reliable
  signal.

### Remaining per-request JS (compiled server)
createContext (~1.35 µs) + the non-empty hook dispatch (i18n/session/
nativePreflight) + reply builders — the natural target for the deferred
**pipeline-only native routes** (one Rust call computes context + validation +
body; JS only wraps the pooled output zero-copy).

## Round 8 — content-length for `ctx.json/text/html` (the `ctx.json()` gap, 2026-08-13)

Round 5 set `content-length` in the codegen `jsonReply` (plain-object returns).
But routes that return `ctx.json(...)` directly (the common dev pattern — e.g.
`/api/orders` `return ctx.json({ ok: true, ... })`) bypass that helper: the
handler returns a `Response`, which `__finalize` passes through untouched, built
by the runtime `ctx.json` (which did NOT set `content-length`). Under
`accept-encoding` (browsers) those responses were still buffered by compression.

### The change
- New shared **`responseWithBody(body, contentType, init?)`** helper
  (`packages/core/src/http/headers.ts`): encodes a string body once, sets an
  accurate `content-length` + content-type, merges `init.headers`, and preserves
  `undefined`-body (empty response) semantics. Correct under
  `exactOptionalPropertyTypes` (conditional `status`/`statusText`).
- **`ctx.json` / `ctx.text` / `ctx.html`** (`packages/core/src/http/context.ts`)
  now route through it — fixing BOTH the compiled server's `ctx.json(...)`
  returns AND the interpreted `createApp` path in one place.
- Together with Round 5, EVERY compiled response now carries `content-length`
  (plain-object returns AND `ctx.json(...)` returns).

### Verified
- Probe: POST `/api/orders` (80-lineItem body, `ctx.json` return) with
  `accept-encoding: gzip` → `content-length: 39`, `content-encoding: null`
  (compression early-returns — no buffer, no gzip).
- Gates: 780/780 vitest, typecheck + lint green (after a `biome --write`),
  app smoke 44/44, interleaved bench native ≈ fallback (0 errors; absolute
  p50 remains thermal-noisy).

### Note on the remaining context cost
`createContext` still eagerly calls `generateRequestId()` (a ~2-string alloc
per request even when the requestId is unused) and builds the cookie jar +
lazy body up front. Making `requestId` lazy is a small follow-up; the bigger
remaining structural work stays the deferred pipeline-only-native-routes.

## Round 9 — cached-context class (Elysia pattern) + lazy requestId (2026-08-13)

The last big single framework-only JS cost in the compiled `needsFull` path and
the interpreted `createApp` path was `createContext`: it built an object literal
with ~25 per-request closures. That's the exact "cached Context class" pattern
Elysia uses (`src/context.ts`, a per-app `WeakMap`-cached class).

### The change (`packages/core/src/http/context.ts`)
- Replaced the object-literal `createContext` with a shared-prototype
  **`IgnexContextImpl` class**: every method + getter (`json/text/html/stream/
  empty/status/redirect/sendFile/proxy/forward/cache/loader`, `url/path/query/
  requestId/ip/state`) lives on the prototype once; each request only allocates
  the instance DATA fields (req, params, set, body, cookie jar, startTime).
  `createContext` is now `new IgnexContextImpl(req, params, opts)`.
- Also made `ctx.requestId` lazily generated (cached getter) — most requests
  never read it, so the ~2-string id is no longer built eagerly.
- Behavior-preserving: same getters/semantics; the compiled server's
  `ctx.server = server` assignment and the plugin/session `ctx.state`/cookie
  access all still work.

### Measured
- `createContext`: **~1350 ns → 516 ns/op** (~2.6×; ~0.83 µs/request saved on
  every `needsFull` + interpreted request). Methods verified working through
  the prototype (`ctx.json` content-type, lazy `requestId`, `ctx.url`).
- Gates: 780/780 vitest, typecheck + lint green (one accepted `warn` for the
  `??=` lazy-cache idiom), app smoke 44/44.

### Cumulative compiled-server JS (per request, from the Rounds 4-9 micro-benchs)
- context creation ~1.35 µs → ~0.5 µs (this round)
- plugin re-wrap chain ~5 µs → ~1.1 µs (Round 6 in-place headers)
- empty hook stages ~1.25 µs → ~0.35 µs (Round 7 guards)
- compression on small responses 2.4 µs → 0.42 µs (Round 5 content-length)
- plus Round 8 `ctx.json` content-length and Round 9 lazy requestId.

Remaining structural target (deferred, documented): compiler **pipeline-only
native routes** (wire-contract extension).

## Cumulative summary — post-Round 9 (2026-08-13)

Net result of Rounds 4–9 across both repos (all micro-bench numbers are per
request on the compiled-server JS path; castrum numbers from the sustained
`02-load`):

### Framework-side JS per request (micro-benchmarks)
| Cost | before | after |
| --- | --- | --- |
| context creation (`createContext`) | ~1.35 µs | **~0.5 µs** (R9 cached-class) |
| plugin response re-wrap chain | ~5 µs | **~1.1 µs** (R6 in-place headers) |
| empty lifecycle stages | ~1.25 µs | **~0.35 µs** (R7 stage guards) |
| compression on small responses | 2.4 µs | **0.42 µs** (R5 content-length) |
| `ctx.json` responses | buffered | content-length emitted (R8) |
| request-id | eager string | lazy (R9) |

### castrum ingress `02-load` (sustained, vs 08-12 baseline)
| metric | baseline | now | |
| --- | --- | --- | --- |
| p50 | 0.590 ms | 0.601 ms | pacing-limited, unchanged |
| p95 | 1.877 ms | **0.860 ms** | ~2.2× |
| p99 | 3.502 ms | **0.976 ms** | ~3.6× |
| p99.9 | 21.5 ms | **2.079 ms** | ~10× |

### Why "more Rust" isn't the remaining lever (evidence)
The Rust pipeline was already sub-µs and <1% of per-request cost. The measured
remaining wins were the JS framework machinery around it; the things that look
like obvious Rust moves actually regress: small-payload validation (precompiled
Ajv 3.6 µs vs `fast_schema` 27 µs), header assembly (conversion tax feeding
`new Response`), arbitrary dev serialization (JS→Rust marshaling), and ops where
Bun built-ins beat FFI (`BUN_WINS`).

### What's deferred (feature-sized, for a follow-up session)
- Compiler **pipeline-only native routes** (wire-contract extension).
- Static-response promotion with pre-baked plugin headers.
- Dynamic routing for interpreted `createApp` + castrum `createIngressServer`
  (`createIngressServerNode`).
- Rust-owned session/rate state (largely covered by native HMAC + native
  limiter already).

### Gates held throughout
780/780 vitest, 205/205 compiler tests, typecheck + lint green, app smoke
44/44, castrum `bench:http:smoke` 0 failures, interleaved bench native ≈
fallback with 0 errors.

## Round 10 — dynamic routing for castrum (feature, 2026-08-13)

The compiled ignex server already handles `:param` via Bun's native router. This
round closed the gap for castrum's own `createIngressServer` / Node adapter.

Key probe finding: **Bun's native `routes` handlers receive `(req, params,
undefined)`** — path params are NOT populated and no server handle is passed in
this Bun version. Since castrum's ingress pipeline does not echo path params in
its response (it processes url/headers/body), dynamic routing for castrum is
purely **route matching** (which handler runs).

### The change (castrum workspace)
- `src/ingress/server.ts`: new exported **`buildPathMatcher(routes)`** — a
  segment matcher supporting `:param` and `*` (rest) segments with
  percent-decoding. Exact (static) paths always win; dynamic patterns are
  ordered most-specific-first (most static segments, then fewest params).
- `src/ingress/server-node.ts`: the Node adapter now dispatches through the
  matcher instead of a direct `routes[pathname]` lookup, so
  `createIngressServerNode` matches `"/users/:id"` / `"/files/*"`. Extracted
  params are passed as an optional 3rd arg to the (raw) handler (current
  ingress handlers ignore it).
- `RouteHandler` type widened with an optional `params` arg (back-compatible).
- Bun path needs no change — Bun's native router already matches dynamic
  patterns (verified by test).

### Verified
- 593/593 castrum TS tests (8 new: matcher unit suite + Node `:param` e2e +
  Bun native `:param` e2e), typecheck clean, `bench:http:smoke` gate clean
  (0 shape/unexpected failures).

### Still open (feature-sized)
- Interpreted `createApp` has no route table (it is a single-handler app by
  design — the route DSL is compiled-server-only), so there is no routing gap
  to close there beyond what the compiled server provides.
- Static-response promotion with pre-baked plugin headers; compiler
  pipeline-only native routes.

## Round 11 — real-world Rust utilization (analysis + real-world bench, 2026-08-13)

Prompted by "isn't our Rust underutilized? improve by a decent margin on
REAL-WORLD workloads." Grounded answer with measurements.

### The key measurement (large-body validation, compiled server)
| items | bytes | `JSON.parse` | Ajv | native `fast_schema` |
| --- | --- | --- | --- | --- |
| 100 | 13KB | 26.6µs | 8.1µs | 27.0µs |
| 1000 | 136KB | 209µs | 53µs | 309µs |
| 5000 | 694KB | 1176µs | 235µs | 1378µs |

For the **happy path (valid body, handler reads it)**, native validation
*regresses*: `fast_schema` ≈ `JSON.parse` cost, and the handler still needs the
parse → double scan (native+parse ≈ 2× parse+Ajv). Handlers need JS objects, so
Rust cannot avoid `JSON.parse`. (A first probe that claimed native was 1.7×
faster was a measurement artifact — it double-parsed in the JS loop.)

Native validation only wins where there is **no DOM parse on the happy path**:
- **Schema-invalid bodies**: reject with zero DOM + zero GC (currently the
  server parses the full 700KB DOM, rejects, then GCs it).
- **Validate-and-ack routes** (body schema, handler never reads `ctx.body`):
  validate the raw bytes natively with a lazy parse — no parse at all.

### Real-world load bench (`bun run bench:realworld`, new script)
Boots the compiled server and hammers realistic traffic classes at
concurrency (default 16, `ITEMS=5000`): small GETs, 700KB valid POSTs,
schema-invalid POSTs, malformed-JSON POSTs, JWT-reject GETs.

Representative (concurrency 16): `GET /health` ~32K rps 0.5ms; `POST /api/orders`
5000 items (valid) ~455 rps 34ms; schema-invalid ~450 rps 35ms (still parses DOM
before rejecting); malformed ~540 rps 29ms; JWT reject ~30K rps 0.5ms.

**Takeaway:** small requests and auth are already excellent; the real-world
bottleneck is large-body POSTs, and the cost there is `JSON.parse` + DOM/GC —
inherent to JS data handling, not the framework or Rust.

### Concrete implementable win (no happy-path regression) — RECOMMENDED NEXT
For routes with a body schema whose handler does **not** read `ctx.body`
(the compiler already tracks `usage.body`), emit native `fast_schema`
validation on the raw bytes with a lazy `body.json` parse (Ajv fallback when
the addon is absent). Avoids `JSON.parse` + the DOM/GC on the happy path for
the common validate-and-ack pattern. Requires a compiler change (native
validator emission + `@ignex/native` dependency in the generated server) — not
yet implemented; the app currently has no qualifying ack-route to demonstrate
it, and the change is fixture/parity-sensitive.

Deferred (large): pipeline-as-engine for derive-pattern routes (validate +
extract fields + serialize the response natively, no DOM) — the wire-contract
extension.

## Round 12 — one-pass native derive-op (Rust tuned for the orders use case, 2026-08-13)

Following up on Round 11, the user pushed: "why not optimize our rust code for
this use case? look at the FFI const and do trial and error testing … run the
same test multiple times so you can get a median. rust FFI performs well in
benchmarks compared to native — we might just not be utilizing it correctly."

### Trial-and-error (medians, 3 runs × 25 samples each)
Built `bench/orders-native-trial.ts` in castrum (since removed from that repo's
`bench/` — historical record): real 473KB / 5000-item orders
body, valid + invalid@0 + invalid@last + malformed variants, Ajv + `fast_schema`
+ `jsonValid` + derive candidates. Repeated 3× for stable medians.

| candidate (473KB body) | median |
| --- | --- |
| `parse+ajv` (valid) — current | ~1700-1980µs |
| native gate → parse+ajv | ~3200-3450µs (regression, double scan) |
| `parse+ajv` (invalid@0) — current | ~1460-1680µs |
| native gate (invalid@0) | **1-2µs** (~800-1600×) |
| `jsonValid` FFI (malformed) | ~400-450µs vs parse ~970-1140µs (2.3-2.9×) |
| derive (valid) — new | **~1600-1870µs** (≈ parse+ajv, zero DOM/GC) |
| derive (invalid@0) — new | **3-5µs** |

Findings:
- The happy path CANNOT be beaten by a validation gate — Bun's `JSON.parse` +
  Ajv-on-DOM is genuinely near-optimal; native validation alone re-tokenizes
  and regresses (confirmed with medians, not theory).
- The real Rust win is a **one-pass derive-op**: validate + extract the
  response's source fields in a single zero-DOM pass. Replaces `parse+ajv`
  (~1700µs) with ~1600µs valid AND ~3µs invalid, with zero DOM/GC.

### Shipped: `SchemaValidator.derive` (castrum)
- `rust/json/fast_schema/capture.rs` (NEW): target JSON-pointers compiled into
  a **trie**; during the SAME validation walk the active node is tracked by
  `(node, alive)` pairs per object level — no per-member key cloning, dead
  subtrees cost nothing (capture adds ~100µs to a 5000-item walk, was ~450µs
  with the path-stack approach). Safety: capture only fires on the ROOT cursor
  (sub-scan cursors are skipped by data-pointer) and under `suppress`.
- `rust/json/fast_schema/errors.rs` + `validate.rs`: capture hooks are OFF by
  default (`Ctx::capture == None`) — bool/detailed hot paths unchanged; the
  `skip_ws()` before `vstart` in `validate_object` is a no-op for validation.
- `rust/json/json_schema.rs`: `SchemaValidator.derive(input, paths)` napi —
  paths are object-key JSON pointers; trailing `/-` = array length. DOM
  fallback for non-fast schemas. 491 Rust tests (incl. byte-parity) pass.
- TS: `SchemaValidatorInstance.derive` + `JsonDeriveResult` types; 598 TS
  tests pass; typecheck clean.
- Proof of the concept: `bench/orders-native-trial.ts` (historical
  trial-and-error artifact; the file was later removed from castrum's `bench/`).

### Wired into the compiled server (`/api/orders`)
- `@ignex/native`: `SchemaValidator.derive` bridge + `JsonDeriveResult` types.
- `packages/native/src/loader.ts`: **bundled-entry fallback** — when the addon
  code is inlined into `dist/__server.js`, `import.meta.url` points at the app,
  so castrum wasn't found (validator silently null). Now walks up from the
  module dir + cwd to find a `packages/*/package.json` declaring a `file:`
  castrum dep and resolves the LIVE repo (bypassing bun's stale install cache).
- `orders.post.ts`: declares no `body` schema (so the compiler skips the
  `JSON.parse` + Ajv prelude) and runs `validator.derive(bytes,
  ["/lineItems/-","/totalCents"])` — 400 on `!ok`, response from derived
  values; JS fallback when the addon is absent.
- Verified end-to-end: valid → 200 `{ok,count,total}`; schema-invalid → 400;
  malformed → 400.

### Real-world bench (transfer-bound, but direction correct)
`bun run bench:realworld` (concurrency 16, 700KB bodies): valid ~439-479 rps,
**schema-invalid ~486-494 rps — now consistently FASTER than valid** (before:
invalid == valid because both parsed the full DOM then rejected). Malformed
~472-522. The absolute win is bounded because the probe is body-transfer-bound
(~700KB × ~480 rps ≈ 330MB/s client↔server); the µs-level validation win shows
up in the microbench and in the invalid-beats-valid signal.

### Bottom line
The trial-and-error answered the question with medians: Rust is NOT
underutilized on the happy path (Bun's JSON.parse wins) — but a one-pass
native derive-op genuinely tunes Rust for this use case (valid ≈ 7% faster +
zero GC, invalid ~800-1600× faster). That op now exists in castrum and is wired
into the real `/api/orders` route.

Deferred: compiler auto-emission of `derive` for derive-pattern routes (the
compiler can't statically infer which body paths the handler derives from, so
routes currently opt in at the handler).

## Round 13 — interpreted router + usage-driven validation prelude (2026-08-14)

Closed the two structural gaps from Round 10: interpreted `createApp` now has a
real route table, and validated routes stop parsing parts they don't use.

### 1. Interpreted router (`packages/core/src/http/router.ts`)
- **`createRouter()`** — fluent `get`/`post`/`put`/`patch`/`delete`/`options`/
  `head`/`all`/`route` registration; `createApp({ router })` serves a Bun-native
  `routes` table (Rust path/method matching) with a compiled-style
  `__fallback`/`__optionsHandler`/`__allowFor` (404/405/OPTIONS) and auto-`HEAD`
  for `GET` routes. `handler()` dispatches through the registry (exact-static
  first, then `:param`/`*` in registration order — Bun-native specificity).
- Per-route wrapper mirrors the compiled `core` fn: guarded lifecycle stages
  (empty chains cost an `if`, not a Promise), runtime schema validation per
  part, `finalizeResponse` reply, single `applySet`.
- Shared reply helpers moved to **`packages/core/src/http/finalize.ts`**
  (`withBody`/`jsonReply`/`textReply`/`htmlReply`/`finalizeResponse`); pure
  path/arg helpers to **`http/router-utils.ts`**. Codegen still emits INLINE
  helpers (perf fallback — no AOT regression; divergence risk documented).
- `createApp.handler` is now optional when a router is present.
- Docs: `docs/router.md` (+ README/architecture links).

### 2. Usage-driven validation prelude (`packages/compiler/.../routes/validate.ts`)
- Per-part emitters: query parsed only when validated OR the handler reads
  `ctx.query` (`usage.query`); headers only when validated; cookies only when
  validated OR read (`usage.cookie`). A body-only schema route no longer parses
  the query string, walks headers, or splits the Cookie header per request.
- `COMPILER_CACHE_VERSION` → 0.6.7; regenerated all compiled artifacts.
- Hardening: compiled-server plugin boot failure now surfaces an attributable
  `[ignex] plugin boot failed for <name>` error (header.ts).

### 3. Comparison-bench results (16-crud-validation-mix, one run, p50 ms)
| server | p50 | vs bun |
| --- | --- | --- |
| bun | 0.328 | — |
| ignus (interpreted router) | 0.394 | +20% |
| ignus-aot | 0.393 | +20% |

Interpreted ignus ≈ AOT p50 — the router closed the architecture gap. The
residual ~+20% over raw Bun is common framework overhead (createContext +
guarded lifecycle + applySet + hook dispatch), the target of the next pass
(lazy `ctx.set`, inline-vs-hook guard, reply-path micro-opts). `ignus-aot` is
now part of the default comparison run + the `bench:compare:check` gate
(0 unexpected failures, 16 scenarios × 4 servers).

### Deferred (unchanged from prior rounds)
Compiler pipeline-only native routes; static-response promotion with plugin
headers; lazy `ctx.set`; legacy single-handler abort-Promise micro-opt.

---

## Round: AOT hot-path allocation cuts (2026-08-14) — VERIFIED

Trial-and-error pass over the AOT-compiled server's per-request hot path,
driven by a new function-level micro-bench harness
(`scripts/bench-hotpath.ts` — evals the emitted `HELPER_SOURCES` templates +
benches core runtime fns with interleaved trials + `Bun.gc()`). **Kept only
changes that measured ≥5% at function level and held in e2e.**

### Applied (verified, verify gate green — 1028 tests)
1. Per-route `createContext` opts hoisted to frozen module consts
   (`__ctxOpts_<ref>`) — kills 1 object/request on the full-context path;
   shared `__ctxOpts` for the OPTIONS/404/error helpers.
2. `new TextEncoder()` → module-level `__encoder` in the compiled
   `jsonReply`/`textReply`/`htmlReply` and core `responseWithBody` — 1 alloc
   removed per response.
3. `__finalize`/`finalizeResponse` skip the `{ status }` object when status is
   200.
4. `__withBody`/`withBody`/`responseWithBody` fast paths: `init === undefined`
   (the common `ctx.json(data)`) now builds plain-object headers and returns
   `new Response(bytes, { headers })` — no `new Headers()`, no rest/spread.
5. `__isServerLike` hoisted to a module const (removes 2 closures/request).
6. `ctx.query` setter added — codegen emits `ctx.query = __query` instead of
   per-request `Object.defineProperty` (~8x slower on a fresh instance).

### Micro-bench deltas (`scripts/bench-hotpath.ts`, ops/s, median-of-5)
| fn | before | after | Δ |
| --- | --- | --- | --- |
| `__withBody` (no init) | 1.09M | 1.77M | +62% |
| `jsonReply` | 658K | 1.13M | +72% |
| `jsonReply {status:429}` | 703K | 1.00M | +42% |
| `__finalize` (200) | 635K | 1.10M | +73% |

### E2E (AOT app, `bench:server` native, median-of-3, 32 conn)
| route | baseline rps / p50 | final rps / p50 | Δ |
| --- | --- | --- | --- |
| GET /health | 2293 / 1.88ms | 2598 / 1.60ms | +13% / −15% |
| POST /api/orders | 2357 / 1.84ms | 2731 / 1.55ms | +16% / −16% |
| GET /api/search | 2416 / 1.80ms | 2835 / 1.51ms | +17% / −16% |
| GET /api/me | 2396 / 1.82ms | 2709 / 1.56ms | +13% / −14% |
| GET /api/reports/42 | 1847 / 1.87ms | 2075 / 1.61ms | +12% / −14% |
| GET /catalog | 1802 / 1.88ms | 2070 / 1.62ms | +15% / −14% |
| GET /api/big | 1381 / 2.84ms | 1618 / 2.45ms | +17% / −14% |

(An earlier repeat measured +19-20% rps — run-to-run variance is ~±3-5%.)

### Rejected / deferred by measurement (trial-and-error)
- `runHooks` sync fast path (skip `await` for non-thenable hooks): measured
  **x0.91** — JSC already optimizes `await` on sync values; the thenable check
  adds overhead. Kept the current implementation.
- `startTime` opt-in (skip `performance.now()` when access-log off): deferred —
  the `logger` plugin reads `ctx.startTime`, so skipping it risks silent breakage.
- `createContext.set` spread removal: no-op (`{ ...undefined }` is free).
- Double-cookie parse: already fixed (`createLazyCookieJar` `preParsed`).

### Rust FFI transfer assessment (trial, external castrum repo)
Added `castrum_query_to_json` / `castrum_cookies_to_json` C-ABI exports
(reusing the ingress's zero-alloc `json_ser::*_into_slice`) and wired them into
`@ignex/native` + `select-native`. Measured **native x0.16 (query) / x0.07
(cookies)** vs the JS fallback → **rejected, wired JS**. The FFI crossing + 8x
output-buffer alloc + UTF-8 decode swamps the Rust parse; Bun's native
`JSON.stringify` wins. Wrappers + BenchOps kept for future re-trials.
Conclusion: for the current hot-path ops, JS-side cuts (above) are the win; the
only remaining structural Rust transfer (whole-lifecycle-in-one-Rust-call
pipeline routes) is deferred.

## Round 14 — lifecycle dispatch + route-wrapper micro-opts (2026-08-19)

CPU-profile-driven pass over the compiled production server
(`packages/app/dist/__server.js`, minified + a non-minified twin for readable
attribution via `bun --cpu-prof --cpu-prof-md`). The profile's top frames:
native `create` (object allocation, ~29% — Bun-internal, not framework-
addressable), `Response` (~7%), `runHooks` (13.8% total incl. the hook work
itself), the `ctx.query` lazy getter + `new URL` for query-reading routes
(~4% combined), and the per-request async layers (`__wrap` + async core fns).

### 1. `runHooks` memoized flatten + inline interpretation (`packages/core/src/lifecycle/lifecycle.ts`)
The per-call loop re-normalized every `HookContainer` (`entry == null` /
`typeof entry === "function" ? entry : entry.fn`) and built a fresh
`{ halted, next }` object per hook on the all-sync hot path. Now the stage
array is flattened to plain callables ONCE (WeakMap-memoized per array identity
— the stage arrays are boot-time consts in the compiled server and the
interpreted router), and the sync loop interprets results INLINE: zero per-hook
normalization, zero per-hook intermediate objects. Async continuation
(`runHooksAsync`) preserves the original timing exactly (only awaits real
Promises — a sync hook in the async path must not add a microtask).
Behavior-preserving: `interpretHook` semantics inlined verbatim.

### 2. Sync `__wrap` (`packages/compiler/src/phases/codegen/helpers.ts`)
`__wrap` returned an `async` fn that did `await handler(...)` — a redundant
second Promise + microtask per request (the route core fns are already async).
The wrapper is now a plain fn: it returns the handler's promise directly and
funnels both a synchronous throw AND a promise rejection into `__handleError`
via a shared `onError` closure (`__r.catch(onError)`). Wildcard/params/server
extraction unchanged. `COMPILER_CACHE_VERSION` → 0.7.4 (output-affecting
codegen).

### Measurements (interleaved A/B, both servers live, 4 rounds × 4 s, conc 8)
Two passes, median-consistent:
| metric | pass 1 | pass 2 |
| --- | --- | --- |
| aggregate rps ratio (new/old) | **1.0132** | **1.0147** |
| per-route | /catalog +4.6%, /api/me +2.5% | /catalog +2.6%, /api/users +2.8% |
| errors | 0 | 0 |

All routes ≥ +0.7% rps on both passes; p50 down 0.2–0.7%. Modest but real and
stable. The earlier claimed "+13.1%" for the `runHooks` change alone was a
measurement artifact (the "old" A/B server wasn't actually serving — every
request errored); the honest end-to-end gain of BOTH changes is ~+1.4%.

### Rejected / measured-no-win
- **Sync core fns for async handlers** (drop `isAsync` gate): REGRESSED — every
  async handler routed through the `resume` continuation (`instanceof Promise`
  check + async resume call) cost more than the async core fn it replaced.
  Reverted.
- **`ctx.query` eager shadow for usage.query routes**: the search handler
  iterates `ctx.query` via `for...of`, which requires an ITERABLE
  `URLSearchParams`; shadowing with the parsed Record (non-iterable) breaks it.
  The lazy `new URL(req.url).searchParams` getter (~1.2 µs/request on
  query-reading routes) stays.
- **`__withBody` `{...__DEFAULT_HEADERS}` spread removal**: the static
  `server.headers` are also applied by Bun.serve's default header sink, but the
  per-response spread is what makes them visible on the `Response` object to
  plugins (compression/security read them) — removal risks silent plugin
  breakage for a sub-µs gain. Left as-is.

### Gates
verify (typecheck + lint + 1305 tests + JSDoc 689/689) green; app smoke 52/52;
check:cache-versions green.

## Round 14b — `ctx.query` lazy-getter micro-opt + Rust-candidate trials (2026-08-19)

Follow-up to Round 14, prompted by "trial and test code chunks that can be moved
to Rust." Profiling showed the `ctx.query` lazy getter + `new URL` are ~4% of the
compiled-server profile on query-reading routes (e.g. `/api/search`, which
iterates `ctx.query`). Trial + outcome:

### Shipped: `ctx.query` builds URLSearchParams from the query substring
`packages/core/src/http/context.ts` `get query()`: `new URL(req.url).searchParams`
→ `new URLSearchParams(url.slice(url.indexOf("?") + 1))` (empty query → empty
params). Micro-bench: **1.15×** vs the full URL parse; byte-identical parity
verified across edge cases (duplicates, malformed `%ZZ`, invalid-UTF-8 `%FF`,
`+`→space, `%2B`, bare keys, empty/absent query — HTTP request URLs carry no
`#` fragment, so the substring parse equals the URL's searchParams). This is a
JS-side cost cut on the SAME path, not a Rust move — the query data itself stays
in JS because the string round trip loses (below).

### Rust-candidate trials (all measured, C-ABI transport, median-of-5 interleaved)
| candidate | native:JS ratio | verdict |
| --- | --- | --- |
| `validateEmail` | 0.22 | JS wins (regex 28M vs native 6M ops/s) — NOT wired |
| `validateUuid` | 0.56 | JS wins — NOT wired |
| `validateIpv4` | 0.35 | JS wins — NOT wired |
| `validateIpv6` | 2.83 | already in FFI_WINS ✓ |
| `createAcceptNegotiator` (compiled instance) | **2.20** | fast but BLOCKED — semantics differ |

The validation trio confirms the documented pattern: string-in/string-out ops
where the JS regex is trivial lose to the C-ABI `cstring` transcode. The accept
negotiator is a genuine 2.2× native win, but its RFC 7231 §5.3.4 ordering
(specificity → q → CLIENT order) differs from the compression plugin's
`negotiateEncoding` (q-only → SERVER order on ties, empty header → null): 2 of 7
realistic headers diverge (`"gzip, deflate, br"` → br vs gzip; `""` → null vs
br). Wiring it would silently change which encoding clients receive, so it was
**not** wired. A future Rust op that replicates the exact q/server-order
semantics would capture the win without the behavior change.

### Cumulative measurement (baseline = HEAD codegen + original core)
Interleaved A/B (both servers live, 0 errors): runHooks memoize + sync `__wrap` +
query getter ≈ **+1.0–2.0%** rps end-to-end (passes: +1.95% / +1.00%; a throttled
pass read +0.2% — the bench box thermal-drifts, so the function-level
micro-benchmarks are the reliable signal). Gates: verify green (1305 tests,
JSDoc 100%), smoke 52/52, check:cache-versions green. NOTE: integration tests
boot the EXISTING `dist` — a stale `dist` built with `generateOpenAPI:false`
made `GET /openapi.json` serve an empty doc (< 1024B → no gzip) and failed one
compression test; rebuild with the real builder before running the app suite.

## Round 15 — native server-preference Accept-Encoding negotiator (2026-08-19)

Implements the Round 14b recommendation: a Rust op that replicates ignex's
`negotiateEncoding` semantics EXACTLY (q-only, server-preference ties, empty →
identity), capturing the 2.2×-class native win WITHOUT the behavior change that
blocked the existing RFC-specificity `AcceptNegotiator`.

### castrum (bun-rust-runtime-bench)
- `rust/http/accept.rs`: new `negotiate_encoding_server_preference` (zero-alloc
  stack path + exact heap fallback — mirrors the existing negotiator's
  discipline) + napi method `AcceptNegotiator::negotiate_server_preference` +
  `accept_negotiator_negotiate_server_core`. Tests: ignex-vector parity, wildcard
  vs explicit, stack/heap parity (14 accept tests).
- `rust/ffi.rs`: new C-ABI `castrum_accept_negotiator_negotiate_server` (same
  opaque-handle → cstring contract) + C-ABI test. `cargo test --lib` 554 pass.
- Rebuilt `.node` (bunx napi build --release --platform) + refreshed the
  bun-cache copy at `node_modules/.bun/castrum@0.9.1+.../castrum.linux-x64-gnu.node`
  (the loader resolves the symlinked install, NOT the repo `.node` — a stale
  copy silently lacks new symbols).

### ignex
- `packages/native/src/ffi.ts`: `acceptNegotiatorNegotiateServer` on the
  instances surface — returns `undefined` for an absent symbol (old addon) vs
  `null` (identity) so callers fall back cleanly.
- `packages/native/src/http/negotiation.ts`: `AcceptNegotiator.negotiateServerPreference`
  (C-ABI → napi → pure-TS) + shared `negotiateServerPreferenceJs` (the
  q-only/server-pref engine, also used by the fallback negotiator). Removed a
  duplicated JSDoc block.
- `packages/core/src/data/content-encoding.ts`: `negotiateEncoding` is now
  native-first via a per-supported-list cached compiled negotiator (the
  compression plugin's lists are fixed per process), pure-TS fallback
  byte-identical. Removed the dead `listed` array from the JS path.
- vendor `castrum.d.ts`: `AcceptNegotiator.negotiateServerPreference` typed.
- Test: `native.test.ts` server-preference semantics (+1).

### Measured
- **Micro-bench (C-ABI): native `negotiateServerPreference` = 1.76×** vs the
  pure-TS engine (4.88M vs 2.77M ops/s).
- **Parity: 28 headers × 2 methods, 0 mismatches** vs the pure-TS engine
  (incl. the Round 14b divergences `"gzip, deflate, br"` → br and `""` → null
  now matching).
- End-to-end A/B with `accept-encoding: gzip, deflate, br`: ~neutral aggregate —
  the negotiation path is only reached for large, non-precompressed,
  compressible responses; this app's responses are small or precompressed, so
  the 1.76× micro-win lands on a sub-1% slice. Correct + parity-safe + a real
  reduction in per-request CPU on compressible payloads.

### Gates
verify green (1306 tests, JSDoc 690/690), smoke 52/52, check:cache-versions
green. Dead-code pass: removed the duplicate JSDoc (negotiation.ts) + the unused
`listed` array (content-encoding.ts); the castrum repo's other modified files
are the user's in-progress work and were left untouched.


## Round 16 — dispatch-shell specialization + dev heat capture (PGO) (2026-08-24)

Two-part pass: (1) the compiler now emits per-route wrapper variants instead of
one runtime-checked `__wrap` for every route, and (2) `ignex dev` captures
per-route request heat so the compiler's hotness heuristic becomes
profile-guided.

### 1. Wrapper variants chosen at build time (`packages/compiler/src/phases/codegen/`)
- Pass 1 records a `WrapVariant` per table-bound handler name
  (`state.wrapVariants`, from `generateRouteCode` / `emitConstantRoute`);
  pass 2 binds it. Unrecorded routes (WS, wildcards) keep the generic
  runtime-checked `__wrap` — exact prior behavior.
- **`__wrapStatic`** — static routes (incl. `:param`) drop the wildcard block:
  no `wildcards.length` branch, no per-request `new URL(req.url)` parse, no
  spread fallback. **`__wrapStaticSync`** — constant-hoisted and sync compact
  routes additionally drop the Promise funnel (`.catch` path only on a sync
  throw). The `needsFull && sync` resume path deliberately stays on the async
  static wrapper (its non-async core can still return a Promise via the cold
  hook-resume continuation).
- **Build-time auto-HEAD for constant GETs**: a module-level
  `function HEAD_<ref>() { return new Response(null, INIT_<ref>); }` is bound
  directly in the routes table — HEAD probes no longer run the GET handler +
  `await` + `new Headers()` re-wrap. Static GETs use `__headStatic`; wildcard
  GETs keep `__head`. Shared `__stripForHead` deduplicates the strip logic.
- The `__fallback` OPTIONS memoized wrapper switched to `__wrapStatic`.
- `COMPILER_CACHE_VERSION` → 0.9.1 (generated shape changed).

### 2. Dev heat capture (`heatCapture` option; `ignex dev` default-on, `--no-heat` opts out)
- Codegen emits a dev-only counter module (`codegen/heat.ts`): per-route
  `__heat["METHOD path"]` increments as the first statement of each core fn +
  an unref'd interval flush to `<outDir>/hot-routes.json`. Zero cost in prod
  builds (option defaults off and is part of the build fingerprint).
- Analysis merges measured counts into `hotnessScore`
  (`phases/analysis/heat.ts`): log-scaled contribution
  `min(10, floor(log2(count+1)))` so session volume cannot swamp the static
  fan-in score. Missing/malformed files degrade silently. Feeds the existing
  inline-budget priority + dedup-leader choice (PGO).

### Verified end-to-end
- Live loop: `ignex dev` on packages/app + 3 curls → `.ignex/hot-routes.json`
  = `{"GET /":2,"GET /health":1}` (exact match); next build's manifest picks up
  the heat bonus (test asserts `hotnessScore` delta == `heatContribution(n)`).
- Built artifact: 18× `__wrapStatic` GET bindings, direct const HEAD for `/`,
  zero generic `__wrap` bindings (app has no wildcard routes).

### Gates
New `dispatch-shell.test.ts` (10 tests: variant binding matrix, HEAD consts,
heat emission on/off, manifest heat merge, malformed-file tolerance).
Full suites green (compiler 297+10, core 820, shared, cli, mcp), verify:quick,
smoke 52/52 native AND `IGNEX_NATIVE=off` fallback parity.

## Round 17 — median selection audit: native was slower than its own JS path (2026-09-11)

**Symptom.** The linux `server-bench` gate failed: with the addon loaded,
native mode served **0.86–0.90x** of the fallback rps on *every* route (p50
1.13–1.28x) — including `/health`, which does no native work.

**The median A/B methodology (reusable — how to find the next bottleneck).**
Five layers, each median-based; each answers a question the previous can't:

1. **End-to-end gate** — `bun scripts/bench-server.ts` (`check-server-bench.ts`):
   interleaved native/fallback windows, per-worker route pinning (a heavy route
   can't flatten the others), reported as the MEDIAN across repeats, with
   per-route rps + p50/p95/p99.
2. **Op-level audit** — `bun run bench:native:all` (`scripts/bench-native.ts`):
   median of 5 interleaved trials of the raw addon call vs the exact JS fallback
   the wrapper would otherwise run, printed next to `effectiveImplFor(op)`. Any
   op whose bound implementation is the measured loser is listed as a
   **MISMATCH** at the end of the run — that list *is* the worklist.
3. **Per-route server CPU/req** — `/proc/<pid>/stat` utime+stime ticks (HZ=100)
   around a fixed request count, one mode per boot. Separates "this route does
   more work" from "this route serves fewer rps".
4. **Isolated sequential p50** — one connection, no concurrency. Removes
   queueing/GC coupling so a per-op cost is visible on its own.
5. **CPU profile** — `bun --cpu-prof --cpu-prof-md --cpu-prof-interval=200`
   under mixed load (writes `<name>.md.md`), for top self-time attribution.

Rules learned: interleave A/B (machine drift cancels); median, not mean; keep
"addon **loaded**" separate from "addon **called**" (loading alone measured 1.00 —
it is not a cost); and treat per-route CPU numbers from *separate* boots as
indicative only — cross-check every claim against an isolated per-op median.

**Findings.**

- `nativeRoutes: true` (compiler default; `packages/app/builder.ts`) emits a
  per-route `createNativeRoute` prelude. The pinned addon (castrum 0.9.4) does
  **not** ship the `castrum_route_*` surface (`createNativeRoute` landed in
  0.10.0), so the prelude could only fall back to the JS path — while still
  paying the per-request native-route dispatch. CPU-profile top self-time showed
  `routeRun` + its native callees; turning the option off restored parity
  (0.98–1.01). Re-enable once the CI pin is castrum >= 0.10.0.
- Median-audit MISMATCHes, both fixed: `createSchemaValidator` (**0.08x** of
  Ajv; and 1.4–1.6x slower than `JSON.parse` + Ajv on the real 15KB order body,
  at every size) and `aeadEncrypt` (**0.76x** @64B, **0.69x** @512B, **0.30x**
  @4KB). Both are pinned to the JS path by a new documented `SELECTION`
  override set (`MEASURED_JS_WINS` in `packages/native/src/selection.ts`).
- `/api/orders` now declares its body schema and runs the compiled
  precompiled-Ajv prelude (the Follow-up #2 "Keep precompiled Ajv" conclusion)
  instead of the native one-pass `derive`. Validation is unchanged (invalid →
  422, malformed → 400) and it is measured faster.

**Results** (`MODE=both REPEATS=3 DURATION=2`, concurrency 32):

| route | before (native/fallback rps) | after |
| --- | --- | --- |
| GET /health | 0.86 | 1.05 |
| POST /api/orders (bulk JSON+schema) | 0.88 | 1.03 |
| GET /api/search (60 params) | 0.86 | 1.03 |
| GET /api/me (30 cookies+sess) | 0.89 | 1.01 |
| GET /api/reports/42 (JWT) | 0.90 | 1.01 |
| GET /catalog (120-item template) | 0.86 | 1.07 |
| GET /api/big (256KB gzip) | 0.90 | 1.05 |

`/api/orders` server CPU/req (median of 5): native **70.7 us → 58.3 us**;
native/fallback **1.34 → 1.01**. Gate: `server-bench gate OK` (native at/above
baseline and ahead of fallback on every route).

**Reproduce**

```
bun run bench:native:all             # op audit + MISMATCH worklist
bun run bench:server                 # end-to-end median A/B (MODE=both)
bun run bench:server:check           # the gate
```

## Round 18 — ingress hot vs cold path: where castrum actually wins (2026-09-11)

Same interleaved-median discipline (isolated harnesses, 7-9 trials, medians),
asked per REQUEST PATH: does the native ingress make the framework faster?
Answer: it depends entirely on whether the response needs JS values — the 2xx
hot path loses, the terminal path wins.

| path | native | JS | verdict |
| --- | --- | --- | --- |
| route stack: query 60 params + 30 cookies | 20.2 us (9.7 call + 10.5 decode) | **13.3 us** | native **1.5x slower** |
| route stack: body valid (2xx) | 40.2 us | **19.2 us** (JSON.parse + Ajv) | native **2.10x slower** |
| route stack: body invalid (terminal 422) | **12.7 us** | 20.1 us | native **1.58x faster** |
| ingress pipeline: query+cookie+CORS | **10.8 us** | 13.9 us | native only because it does NOT materialize pairs |
| transport (FFI vs NAPI), same op | identical (0.65x both) | | the crossing is NOT the bottleneck |

- **Hot path (2xx) — JS wins.** Two structural costs: (1) cross-boundary
  MATERIALIZATION — re-creating 180 pair strings from bytes costs 10.5 us,
  more than JS's entire parse (which hands back zero-copy slices of the source
  string); and (2) Rust's JSON parse vs Bun's `JSON.parse` (15 KB body: native
  40 us vs 19 us for parse + precompiled Ajv).
- **Cold/terminal path — native wins.** A 422/413/429/403/204 decision needs no
  JS values, so the native pipeline is pure gain (1.58x on this probe;
  400-1600x on early large-body rejection).
- **Bottleneck found on the hot path:** the pipeline ran in FULL for any request
  carrying an `Origin`, even when its verdict was the non-terminal "allow" the
  OK path drops — only a TERMINAL response consumes the native verdict (the
  OK-path `access-control-*` echo is owned by the JS `cors()` plugin / Bun's
  default header sink).
- **Fix:** `skipWhenSafe` (default on) now also skips **allowlisted-origin**
  non-preflight requests while CORS is the pipeline's only decision stage (any
  `rateLimit`, `schema`, body/JSON guard or trust-proxy config keeps it live).
  Preflights and non-allowlisted origins are untouched. Measured: 21.3 us ->
  **17.9 us** per such request (-16.2%; the saving scales to ~10.7 us on a
  60-param payload).
- **Kept as-is (evidence-based):** the route stack stays OFF for pair-parsing
  stages and body validation stays JS on the accept path — both measure slower
  natively. The native reject path stays available and is the one to reach for.

**Reproduce** (harness pattern: one process per mode, warm, interleaved trials,
median; `IGNEX_FFI_MODE=napi` vs default for the transport axis): parse a route
plan with `createNativeRoute`, call `runParts`, and compare against
`queryPairs`/`cookiePairs`; for the pipeline, `createNativeIngress` +
`preprocess` against the JS parse work; for the guard, `createApp` with
`skipWhenSafe: true` vs `false`.

## Round 19 — `is it the FFI crossing?` (boundary attribution, 2026-09-11)

Bun documents a **10-50 ns** FFI call cost, yet the native route stack measures
1.5x SLOWER than JS. So is the crossing the culprit? A/B/C, medians of 9
interleaved trials, idle machine:

| probe | median | what it isolates |
| --- | --- | --- |
| `ffi.crc32(8B)` (raw symbol) | **43 ns** | the crossing itself (~0 Rust work) |
| `ffi.crc32(64B / 256B / 4KB / 64KB)` | 51 / 57 / 315 / 4393 ns | crossing + Rust slope (~0.066 ns/B) |
| route call, EMPTY pipeline | **546 ns** | crossing + wrapper protocol (pack/scratch/decode) |
| route call, FULL pipeline | **20,400 ns** | the whole hot path |
| JS `queryPairs` + `cookiePairs` | **13,800 ns** | the JS implementation |

Attribution of the 20.4 us native call:

| component | cost | share |
| --- | --- | --- |
| FFI crossing | 0.043 us | **0.2%** |
| encode + frame pack | ~1.1 us | 5% |
| Rust parse (inside the addon) | ~9.8 us | **48%** |
| JS decode of the result wire | ~9.4 us | **46%** |

Transport axis: **identical** on `IGNEX_FFI_MODE=ffi` and `napi` (0.65x both) —
a ~100-350 ns NAPI crossing is invisible next to ~20 us of work, which is only
possible because the crossing really is tiny.

**Verdict: Bun's 10-50 ns claim is confirmed, and the crossing is NOT the
bottleneck.** The cost is (1) Rust re-parsing data JS already has and (2)
materializing the result back into JS strings. JS wins the hot path because its
parser hands back ZERO-COPY slices of the source string. The body axis has the
same shape: native 40.0 us vs JS 18.0 us to ACCEPT a valid body (2.23x slower),
native 12.9 us vs JS 18.6 us to REJECT one (1.45x faster).

Method note: an earlier pass of this measurement ran WHILE a `cargo build` was
compiling in the background and inflated every number ~3x (including the JS
baseline) — one thing at a time, and re-run the baseline to prove it is stable.

Caveat: an in-crate Rust-native (zero-boundary) probe could not run — castrum
main (`efac103`) fails `cargo test --release` on the known `pbkdf2 0.12` /
`digest` version conflict; the CI pin `ee3d86a` is the buildable revision. The
attribution above therefore uses the empty-pipeline call as the boundary floor.

**Reproduce**

```
# A) crossing floor          ffi.crc32(new Uint8Array(8))       -> ~43 ns
# B) boundary + protocol     createNativeRoute({ pipeline: [] }).runParts("", "", null)
# C) full hot path           createNativeRoute({ pipeline: ["parseQuery","parseCookies"] }).runParts(q, c, null)
# D) JS implementation       queryPairs(q) + cookiePairs(c)
# E) transport axis          IGNEX_FFI_MODE=napi <same script>
```

## Round 20 — castrum: fix the build + kill the route parse double pass (2026-09-11)

Followed straight from Round 18/19 (Rust = 48% of the hot path). Two defects:

1. **The crate did not build.** Dependabot bumped `sha2` 0.10.9 -> 0.11.0
   (commit `810fd90`), but `pbkdf2 0.12` requires digest 0.10, so
   `pbkdf2_hmac::<Sha256>` stopped compiling (E0277 `CoreProxy`) and
   `cargo test --release` could not build castrum at all. `sha2` is consumed ONLY
   by pbkdf2, so it is pinned back to `0.10` with a comment stating that a future
   bump must ride a pbkdf2 release that depends on digest 0.11.
2. **`NativeRoute::run` walked every pair section TWICE** — a sizing pass
   (`query_section_size` / `cookie_section_size`) then a write pass
   (`write_query_section` / `write_cookie_section`) — and each pass called
   `decode_segment_lenient`, which allocated `Vec::with_capacity` for the `+`
   replacement AND a second `Vec` for the percent decode. The bench payload has
   80 `%` escapes, so ~21 segments x 2 allocations x 2 passes = **~84 allocations
   per route call**.

**Fix: one streaming pass.**

- `decode_segment_scratch(seg, scratch)` decodes leniently into a caller-provided
  scratch buffer reused across every segment of the call — zero per-segment
  allocation, and the `memchr2` fast path returns the borrowed slice untouched.
- `ResultWriter` appends into the caller's buffer while tracking the EXACT
  required size; once the buffer proves too small it stops copying (and stops
  patching) but keeps counting, so the needed-size convention still answers from
  one pass instead of three.
- The verdict header is committed LAST, so a too-small buffer is still left
  untouched — the contract the JS wrapper (`growExact`) relies on.

Measured with an in-crate probe (`cargo test --release -- --nocapture`) on the
exact payload the Bun harness uses (query 2055 B + cookie 602 B):

| | ns/op (median of 7) |
| --- | --- |
| before | 9,494 |
| after | **3,993** |

**2.38x faster on the Rust side**, with castrum's JS-parity vectors green
(`parse_query_lenient_matches_js_vectors`, `parse_cookies_matches_js_vectors`,
`needed_size_convention`, `short-write` contract).

Where the call's cost sits now: FFI crossing ~0.2%, Rust parse ~4.0 us, JS decode
of the result wire ~9.4 us — so on the `@ignex/native` side the JS wire decode is
the remaining dominant cost, and **the Rust parse is no longer the bottleneck**.
The FFI C-ABI ingress entry (`castrum_ingress_handle_components`) was audited too
and has no per-call allocation, so no change was needed there.

**End-to-end through the FFI layer** (cdylib built with
`cargo build --release --lib`, injected with
`IGNEX_NATIVE_PATH=.../castrum.linux-x64-gnu.node`, medians on an idle machine):

| | before (registry 0.9.4) | after (optimized) |
| --- | --- | --- |
| FFI route call (60 params + 30 cookies) | 20,400 ns | **15,108 ns** (−26%) |
| empty-plan floor (crossing + protocol) | 546 ns | 547 ns (unchanged) |
| JS `queryPairs` + `cookiePairs` (baseline) | 13,800 ns | 13,885 ns (stable) |
| native / JS ratio | 0.65x | **0.85x** |

The floor being unchanged is the control: the gain came from the Rust parse, not
from the boundary. The call now decomposes as 0.55 us floor + 4.0 us Rust +
~10.5 us JS decode — the decode is 70% of it, i.e. **the remaining bottleneck on
this path is the JS-side materialization of the result wire**, not anything
native.

Parity: `verify:native:route` all pass; `verify:native:ffi` 75/75 (the script's
`createSchemaValidator` check was updated to respect the Round-17 SELECTION pin —
it asserted non-null and had been failing since, now it asserts the pin AND
exercises the raw C-ABI `castrum_schema_validator_validate` path directly);
castrum's own suite green (596 tests) plus `cargo fmt --check` and clippy.

## Round 21 — the FFI layer: measure the decode, not the crossing (2026-09-11)

Round 20 fixed the Rust parse; this round went one level deeper with a
noise-resistant harness (mechanics now documented in
[`docs/perf-methodology.md`](./perf-methodology.md): `Bun.nanoseconds()`, fixed-op
trials, 11 interleaved rounds with a rotating lead, median + min + CV%).

**The next bottleneck was the decode, not the boundary.** One route call, medians
(CV 1.6-8.7%):

| component | before | after |
| --- | --- | --- |
| `ffi.routeRun` (Rust parse, pre-packed frame) | 9,805 ns | **3,998 ns** |
| `readRouteResult` (95 pairs / 3,055 B wire) | 10,225-11,213 ns | **6,143-6,347 ns** |
| empty-plan floor (boundary + wrapper protocol) | 575 ns | 614 ns *(control: unchanged)* |
| **`runParts` — the full call** | **21,623 ns** | **11,439 ns** (-47%) |

The decode was per-string `CString` reads (190 engine reads for 95 pairs). It now
has an **ASCII fast path**: ONE decode of the whole pair region plus byte-offset
slices, measured **1.48x** faster (11.2 us -> 7.6 us, interleaved A/B). ASCII is
a CORRECTNESS gate, not a heuristic — with every byte < 0x80 one byte is exactly
one UTF-16 code unit, so a wire byte offset maps straight to a string index (the
interleaved length prefixes decode to control characters the offset arithmetic
steps over). The scan aborts at the FIRST non-ASCII byte (typically early — a
length >= 128 puts a high byte in a prefix), so a non-ASCII region pays only that
prefix of a scan and then runs the ORIGINAL single-pass loop: measured **0.99x**,
no regression. Worth recording how nearly this went wrong — the first version
validated the wire in a separate pass and cost the fallback **15%**; measuring
BOTH cases (not just the happy one) is what caught it.

**Result: the native route stack now wins.**

| payload | before (native/JS) | after |
| --- | --- | --- |
| 60 params + 30 cookies | 0.80x (loses) | **1.20x (wins)** |
| 3 params + 2 cookies | 0.22x | 0.22x |
| empty | 0.10x | 0.09x |

Which restates the rule with numbers: the native stack pays a ~0.6 us wrapper
floor plus a per-pair decode, so it wins on **parse-heavy** routes and loses on
trivial ones — that is a payload-size decision, not a feature flag.

Tests: 3 new parity tests (ASCII fast path vs an independent
`DataView`+`TextDecoder` reference, multibyte/emoji/mixed fallback, empty
section); native suite 146 green, `verify:native:route` and `verify:native:ffi`
(75/75) green.

## Round 22 — "make the fast path selectable": a 1.22x win that is a 500 (2026-09-11)

Goal: the decode fast path (Round 21) had changed the economics of the packed
pair parsers, which were still pinned to JS from pre-optimization measurements
(`queryPairs` x0.96, `cookiePairs` x0.65). If the numbers moved, `ctx.query`
would ride native on every request — a real framework-level win. So: re-measure
first, select second.

### 22.1 The re-measurement (median mechanics, interleaved, rotating lead)

Payload: the real-data query (`searchQuery(n)`, 80 `%` escapes) and a 30-cookie
header. Two runs were needed to get an HONEST number.

First pass — native input pre-encoded OUTSIDE the timed loop:

| params | bytes | native+decode | JS fallback | ratio |
| --- | --- | --- | --- | --- |
| 1 | 99 | 1,026 ns | 916 ns | 0.89x |
| 8 | 315 | 2,156 ns | 2,336 ns | 1.08x |
| 16 | 589 | 3,392 ns | 4,125 ns | 1.22x |
| 60 | 2,205 | 9,862 ns | 12,454 ns | 1.26x |
| 96 | 3,267 | 13,766 ns | 18,199 ns | 1.32x |

...but the wrapper receives a STRING, so the native path must pay
`encoder.encode(input)` (~180-650 ns) — the same "charge the real path" rule
that bit the ingress pipeline in Round 18. Re-run with the encode INSIDE the
native variant:

| params | bytes | native+encode | JS fallback | ratio | verdict |
| --- | --- | --- | --- | --- | --- |
| 1 | 99 | 1,229 ns | 988 ns | 0.80x | js |
| 6 | 243 | 2,072 ns | 1,855 ns | 0.90x | js |
| 12 | 439 | 2,903 ns | 3,039 ns | 1.05x | dead band |
| 16 | 589 | 3,561 ns | 4,171 ns | 1.17x | native |
| 32 | 1,120 | 6,326 ns | 6,895 ns | 1.09x | native |
| 60 | 2,205 | 11,202 ns | 13,275 ns | 1.19x | native |
| 96 | 3,267 | 15,884 ns | 19,079 ns | 1.20x | native |

So the honest crossover is between 439 B and 589 B — exactly the shape SIZE_GATES
exists for (`jsonValid` has the same shape at 256 B). `cookiePairs` was
re-measured the same way and still loses (0.78x): a cookie header is one flat
`;`-separated list with no percent-decoding, which is what `String.split` is
best at.

### 22.2 The selection, implemented the established way

* `FFI_WINS` (`runtime.ts`) — the C-ABI-only override list — gains `queryPairs`
  (NAPI/Node keep JS: the win is FFI-specific, same as `etag`/`jsonValid`).
* `SIZE_GATES.queryPairs = { jsBelowBytes: 512 }` — the middle of the measured
  dead band, so neither side is claimed inside noise.
* `http/query.ts` checks the gate BEFORE `toBytes`, so the JS path pays no
  encode it never paid before (an unconditional `toBytes` would have taxed the
  common small-query path to measure the rare large one).
* `verify:native-ffi` gained 5 checks: the binding, the gate boundaries, and
  byte parity of the routed wrapper + raw C-ABI parse on both sides of the gate.
  85/85 green. Measured end-to-end effect on the routed wrapper: 589 B 1.11x,
  2.2 KB 1.22x, tiny sizes unchanged (0.92-1.05x = noise).

### 22.3 ...and then the compatibility fuzz, which killed it

A speed win means nothing if the fast path answers a different question. The
existing parity suite is all WELL-FORMED inputs, so it passed. A differential
fuzz against the JS fallback (20,011 inputs, charset weighted to `%`, `+`,
truncations, multibyte, NUL) told the real story:

```
cases=20011 throws=17496 mismatches=322
  "a=%"    -> THROWS query: parse failed        (js: [["a","%"]])
  "a=%2"   -> THROWS query: parse failed        (js: [["a","%2"]])
  "a=%2G"  -> THROWS query: parse failed        (js: [["a","%2G"]])
  "a=%C3"  -> native [["a","\uFFFD"]]  vs js [["a","%C3"]]   (lossy vs raw)
```

A malformed escape is attacker-supplied on any public route: selecting this op
converts a bad query string into a **500** (and a divergent parse) — a DoS
surface, not a slower option. The 1.22x was real and the flip was still wrong.

Why the fallback differs: `decodeSegment` is
`try { decodeURIComponent(s.replace(/\+/g," ")) } catch { return s }` — on ANY
invalid escape the WHOLE segment is returned raw (with `+` still `+`), while the
Rust decoder percent-decodes progressively, lossily, or fails outright.

### 22.4 Outcome

* **Reverted the flip.** `queryPairs` stays JS, but the pin is now recorded as a
  CORRECTNESS pin with the repros in `http/query.ts`, the measured win still
  written down (so the work is not lost), and the exact per-segment Rust
  semantics needed to make it selectable: if a segment contains `%`/`+`, decode
  with strict UTF-8 (reject overlongs, surrogates, truncated and non-hex
  escapes); on ANY failure emit that segment's ORIGINAL bytes (`+` NOT
  unescaped).
* **Tripwires.** `scripts/verify-native-ffi.ts` (Bun, live C-ABI) asserts the pin
  and PRINTS flip-readiness (`readiness: queryPairs stays JS — 6/7 malformed
  cases still differ or throw (e.g. a=%2: THROWS query: parse failed)`), so the
  day castrum's decoder is fixed the gate says so. `packages/native/test/size-gates.test.ts`
  asserts the routed wrapper keeps `decodeURIComponent` semantics for
  `a=%C3` / `a=%2` on both transports.
* **Cache versions untouched** — `git diff` on `runtime.ts`/`selection.ts` shows
  no behavioral change, so no bump is owed (`check:cache-versions` agrees:
  comment-only edits do not move the pinned constants).
* **The lesson is now in the runbook** (`docs/perf-methodology.md` §3): a
  well-formed parity suite is not a compatibility proof; fuzz the malformed
  space before selecting an op.

### 22.5 Where the real remaining win is

The fastest 1.22x of this round is locked behind a Rust decoder fix, not a JS
change — castrum's `query_parser` must implement the per-segment raw-on-failure
semantics before `queryPairs` can be selected. Until then the honest state is:
the native route stack wins on parse-heavy requests (Round 21), the packed pair
parsers win on query (but cannot be selected), and `cookiePairs`/`formPairs`
legitimately stay JS.

### 22.6 Side findings (measured, so nobody re-derives them)

* **Bun 1.4.2 FFI practices are already satisified by the bridge** — verified
  against the docs and this machine: `read.u8/u32/u64` (no `DataView`/
  `ArrayBuffer` allocation for short-lived pointers), `CString` with
  offset+length for UTF-8, TypedArrays passed straight into `ptr` positions, and
  `dlopen`/`linkSymbols` used directly (JSC compiles hot call sites to direct
  calls — that is why a crossing is 43 ns rather than µs). The
  `buffer`/`buffer_length` ABI (engine snapshots ptr + byteLength off ONE object)
  is probe-gated in `ffi.ts` with a `(ptr, usize)` fallback, and IS accepted by
  Bun 1.4.2 — measured **1.01x** vs `(ptr, usize)` at 8 B and 2 KB, i.e. the
  shape buys atomicity, not throughput. The full table now lives in
  `docs/perf-methodology.md` §5.
* **The per-call result view in the route hot path is not worth removing.**
  `out.subarray(0, w)` before the decode allocates a ~60 ns view against a
  6,143 ns decode (0.98%) and an 11,439 ns route call (0.5%). Passing
  `(ffiBuf, endOffset)` into the decoder instead would cost more in signature
  churn than it returns — recorded as measured-and-rejected.
* **The transport axis stays a non-issue**: `IGNEX_FFI_MODE=ffi` vs `napi` is
  indistinguishable on our ops (the 100-350 ns NAPI crossing is <2% of a call),
  so the C-ABI preference is about the extra surfaces it exposes (cstring args,
  packed writers), not about the crossing itself.

## Round 23 — root cause: fix castrum's decoder, then select the fast path (2026-09-11)

Round 22 ended with the query-parser win blocked: the packed parser was 1.17-1.22x
faster past ~589B, but it THREW on malformed escapes (17,496/20,011 fuzzed inputs)
and decoded invalid UTF-8 lossily, where JS `decodeURIComponent` throws and the
fallback returns the segment raw. Pinning it to JS was the safe state — and the
wrong end state. This round fixes the cause instead of guarding the symptom.

### 23.1 The cause was not "Rust can't decode" — it was TWO implementations

`rust/util/bytes.rs::decode_form_component_into` (shared by `query_parse_packed`
and the query→JSON writer) returned `FormDecodeError::Malformed` for a bad `%XX`
and never validated UTF-8 — so the C-ABI packed writer reported failure, the JS
wrapper threw, and an attacker-supplied `?a=%2` was a 500.

Meanwhile `rust/ingress/native_route.rs::decode_segment_scratch` — written for the
route stack in Round 20 — ALREADY implemented the correct contract: malformed
escape → the whole original segment, invalid UTF-8 → the whole original segment.
Two decoders, two answers, one of them wrong. So the fix was not "add error
handling": it was **delete the duplicate**.

### 23.2 The fix (castrum 0.9.5)

* One core (`decode_form_core`) owns the semantics, with the JS contract written
  down where it lives: per COMPONENT, `+` → space and `%XX` → byte; a malformed
  escape or a non-UTF-8 result → the WHOLE component RAW, `+` included, because
  JS's `catch` returns the string *before* the replace.
* **`simdutf8`** (already a dependency, used by `url_codec`) validates the decoded
  bytes — its rejection set is exactly `decodeURIComponent`'s: overlongs,
  surrogate halves, > U+10FFFF. It is only paid when a high byte actually reaches
  the output (`saw_high`), so the ASCII case (`%20` escapes in a real query) never
  calls it. Only `BufferTooSmall` remains an error: with the raw fallback, the
  decoded length never exceeds the input, so an input-sized buffer always fits.
* The route stack now CALLS the shared decoder (its private `decode_segment_scratch`
  loop and local `hex_val` are gone), and the query→JSON writer uses the same
  lenient arm — which also removes the last "native 400s where JS answers 200"
  divergence (`QueryJsonError::Malformed` had no other producer).
* The "needed size" pass (`decode_form_component_len`) mirrors the raw fallback
  and may only OVER-report; under-reporting would spin the caller's
  grow-and-retry loop forever, so that direction is asserted by a test.

### 23.3 The acceptance test is the fuzz, not the unit tests

`400,520` differential comparisons against the JS fallback — every truncation
window of nasty seeds, plus 200k generated inputs (charset saturated with `%`,
hex digits, `+`, separators, NUL, control bytes, literal multibyte) run through
BOTH packed parsers:

```
fuzz: 400520 comparisons | real failures: 0 | lone-surrogate inputs (not a parser diff): 0
```

The first run of the big fuzz did report failures — inputs containing LONE
SURROGATES, which `TextEncoder` cannot represent (it substitutes U+FFFD before the
parse starts), so the two sides were never parsing the same bytes. That is an
input-encoding nuance, not a decoder difference; it is now documented in the
wrapper, and the comparison is defined on the bytes the native side actually sees.

### 23.4 Selecting it — behind a probe, because old addons exist

The win is only safe on a fixed decoder, and the installed addon in this
workspace is 0.9.4 (broken). Rather than pin the op to JS until everyone
upgrades, the binding is PROBE-GATED — the same pattern as the
`buffer`/`buffer_length` ABI probe:

* `src/decode-compat.ts` runs 9 literal expectation cases (malformed, invalid
  UTF-8, surrogate half, valid multibyte, `+`) once per process against the live
  C-ABI surface and memoizes the verdict. Expectations are literals on purpose:
  asking the implementation under test what the answer should be would prove
  nothing, and importing the fallback would be a cycle.
* `useNative("queryPairs")` = live ffi **and** the probe passes.
* `SIZE_GATES.queryPairs = { jsBelowBytes: 512 }` — the middle of the measured
  dead band (439B JS wins 1.05x, 589B native wins 1.17x).

Result, same session, routed wrapper vs pure-TS fallback:

| input | native/js | path |
| --- | --- | --- |
| 99B / 147B / 243B / 439B | 0.98-1.06x | js (gate) — no regression |
| 589B | 1.04x | native |
| 1,120B | **1.14x** | native |
| 2,055B (60 params) | **1.19x** | native |

And the gates prove both generations: with the registry 0.9.4 addon the probe
reports incompatible → op stays JS → `verify:native:ffi` passes 151 checks
(raw-surface checks are skipped there BECAUSE they are expected to diverge);
with 0.9.5 → compatible → native → 226 checks, including the malformed battery on
the routed wrapper AND the raw C-ABI parse. smoke is 52/52 in every mode.

### 23.5 The audit's false alarm was a second real bug

Running the selection audit after the flip produced:

```
audit: 1 op(s) run the SLOWER implementation:
  - aeadEncrypt — runs js, faster is castrum (native/js 1.20x)
```

`aeadEncrypt` was pinned to JS by `MEASURED_JS_WINS` from a 0.76x/0.69x/0.30x
measurement. Re-measured on the raw surfaces, the pin was TRUE for one transport
and FALSE for the other:

| transport | 64B | 512B | 4KB |
| --- | --- | --- | --- |
| addon (napi) | 0.89x | 0.93x | 0.86x |
| **C-ABI (ffi)** | **2.02x** | **1.73x** | **1.64x** |

So the pin had been applied framework-wide from an addon-transport measurement —
and Bun (the runtime that actually serves requests) was running the *slow* path
for every session/token encryption. Fix: keep the table pin (`js`, which is what
NAPI/Node get) and add the op to `FFI_WINS`, the mechanism that exists for exactly
this. AEAD is now native on Bun: 1.9-2.0x at 16-79B, 1.73x at 512B, 1.47-1.64x at
2-4KB, ciphertext-identical.

The audit itself was structurally unable to see this: it drives the napi handle
and compared the result with `effectiveImplFor(op)`, which folds in C-ABI-only
overrides — judging a C-ABI override with napi timings. It now compares against
the static table (what the measured transport actually applies) and prints the
C-ABI-only overrides separately for `verify:native:ffi` to own:

```
audit: OK — every measured op runs the implementation the median says is faster
(addon/napi transport; C-ABI-only overrides are listed below).
C-ABI-only overrides (native on Bun, judged by verify:native:ffi): aeadEncrypt,
hmacSha256, randomToken, etag, jsonValid, validateIpv6
```

### 23.6 What this round says in one line each

* **Two implementations of one rule will drift.** The route stack was right and
  the shared decoder was wrong; the fix was to delete one of them.
* **"Native loses" is not a property of an op, it is a property of a transport.**
  Check which one you measured before pinning — an addon-transport loss was
  hiding a 2x C-ABI win on the framework's per-request crypto.
* **Pin to safety, select behind a probe.** The op could be bound the same day the
  fix landed without waiting for every environment to upgrade, and an old addon
  degrades to exactly the previous behaviour instead of throwing.
* Numbers: queryPairs 1.14-1.19x (past 512B) newly selected; aeadEncrypt
  1.47-2.02x newly selected on Bun; `verify:native:ffi` 151 → 226 checks;
  castrum 597 tests + clippy/fmt clean at 0.9.5; ignex verify green (1,952 tests,
  jsdoc 1,011/1,011, knip clean), smoke 52/52 x3 modes.

## Round 24 — `bun link`, a selection audit that found two live bugs, and the hot-path profile (2026-09-11)

Goal: stop *measuring* the dev addon and start *running* it — link castrum 0.9.5
into the monorepo, verify, then make sure nothing on the hot path is left
selecting a slower implementation.

### 24.1 `bun link` — and the trap that cost the first attempt

`bun link` needs a *package-shaped* checkout: castrum's own loader expects
`castrum.linux-x64-gnu.node` in the package root, which `cargo build --release
--lib` does not produce by itself.

```bash
cd /home/adeel/poc/castrum
cp target/release/libcastrum.so castrum.linux-x64-gnu.node   # baseline
bash scripts/build-v3.sh                                     # x86-64-v3 SIMD variant
bun link                                                     # register
cd /home/adeel/poc/ignex && bun link castrum                 # → node_modules/castrum
ln -s /home/adeel/poc/castrum packages/native/node_modules/castrum   # the package @ignex/native resolves from
```

(`bun link castrum` inside `packages/native` fails on `@ignex/test-utils@workspace:*`
resolution outside the workspace root, so the symlink is created directly — the
same link state bun would produce.)

**The trap:** a lingering `export IGNEX_NATIVE_PATH=<registry 0.9.4 path>` from an
earlier session silently won over the link, because `castrumFromOverride()` is the
loader's FIRST resolution step. Every check looked like "the link did not work"
until the env var was found. Verify with:

```bash
echo "IGNEX_NATIVE_PATH=${IGNEX_NATIVE_PATH:-<unset>}"
bun -e 'import {getAddonPath,isNativeAvailable} from "./packages/native/src/loader.ts";
        import {nativeQueryDecodeMatchesJs} from "./packages/native/src/decode-compat.ts";
        console.log(getAddonPath(), isNativeAvailable(), nativeQueryDecodeMatchesJs())'
```

With the link live the loader picks the **v3 SIMD binary automatically**
(`supportsX8664V3()` → prefers `*-v3-*`): `addon path
…/packages/native/node_modules/castrum/castrum.linux-x64-v3-gnu.node`, probe
compatible → `queryPairs` **castrum**. Full verification on the linked addon:
`verify` exit 0 (1,952 tests), `verify:native:ffi` **227/227** (the query-parity
battery now runs because the probe passes), `verify:native:route` ✓, smoke
**52/52** native + fallback, `bench:server:check` OK, `check:native:surface` 70/70.

### 24.2 The utilization sweep: what is still selecting the slower implementation?

The audit (`bench:native:all`) only drives the **addon (napi)** handle, so it can
never see a C-ABI-only win. Sweeping every op whose effective impl is still `js`
for a *live C-ABI binding* left 9 candidates (the rest — SSE, websockets,
multipart, media-type, gzip — exist only on napi/instances, so the audit owns
them).

**Two measurement traps decided this round:**

1. **Constant input gets const-folded.** The first pass compared
   `ffi.validateEmail(s)` against `validateEmailFallback(s)` with a literal
   string and reported JS at 1.7 ns (cv 163%) — the JIT had hoisted the whole
   regex test. Re-run with a 16-string rotating pool: JS 38.8 ns.
2. **Charge the real path.** The same pass gave the JS side
   `validateEmailFallback(encode(s))` (an encode the production wrapper never
   pays, since the C-ABI takes `cstring`) — 620 ns of fiction that made native
   look 4.4x faster than it is.

Honest, varied-input numbers (100k ops/trial, cv 0-5%):

| op | C-ABI | JS | verdict |
| --- | --- | --- | --- |
| `validateEmail` | 139 ns | **38.8 ns** | JS wins 3.6x → stays JS |
| `validateIpv4` | 64.1 ns | **36.7 ns** | JS wins 1.75x → stays JS |
| `validateUuid` | **36.6 ns** | 41.2 ns | native 1.13x → **now FFI_WINS** |
| `validateIpv6` | **101 ns** | 252 ns | native 2.49x ✓ already bound |

And the contested hash/rand ops across all four implementations
(100k ops, min):

| op | Bun builtin | addon (napi) | C-ABI | verdict |
| --- | --- | --- | --- | --- |
| `crc32` 128B | 36.7 ns | 202 ns | **19.2 ns** | C-ABI 1.9x over Bun, Bun 5.5x over napi → **both sets** (like `hmacSha256`) |
| `hmacSha256` 64B | 1,112 ns | 1,419 ns | **767 ns** | C-ABI wins 1.45x → `FFI_WINS` keeps it |
| `randomToken` 32B | **191 ns** | 802 ns | 194 ns | tie on C-ABI → leave as-is |
| `etag` 128B | 81.7 ns (crc32+hex) | — | **63.8 ns** | C-ABI 1.28x ✓ already bound |

`crc32`'s split is the whole pattern in one row: **Bun's builtin beats the Rust
addon by 5.5x on the napi transport and loses to it by 1.9x on the C-ABI**, which
is exactly what the dual `BUN_WINS` + `FFI_WINS` membership expresses.

### 24.3 Two live bugs the sweep exposed

**A. The EdDSA pin never engaged — a name mismatch.** `PINNED_NATIVE` lists
`jwtSignEdDsa`/`jwtVerifyEdDsa`, but napi exports `jwtSignEddsa`/`jwtVerifyEddsa`
(camelCase of `jwt_sign_eddsa`). `hasPinnedSymbol()` looked up a method that does
not exist, returned false, and the op fell through to `opImpl` = `null` → **js**:
every RBAC EdDSA token was signed/verified by the JS fallback. Measured cost:

| | C-ABI | JS fallback | native/js |
| --- | --- | --- | --- |
| EdDSA JWT sign | 16.4 µs | 29.6 µs | **1.80x** |
| EdDSA JWT verify | 34.1 µs | 49.5 µs | **1.45x** |

Fixed with an explicit `PINNED_SYMBOL_ALIASES` map (op name → addon export name)
so the check and the wrapper agree.

**B. `crc32` was pinned to Bun everywhere.** `BUN_WINS` was set from an addon-era
measurement and applied on every transport, so Bun's builtin answered even under
the C-ABI where the Rust SIMD crc32 is 1.9x faster (verified on BOTH addon
variants, baseline and v3). Now in `FFI_WINS` as well — same shape as
`hmacSha256`.

### 24.4 The FFI layer, checked rather than assumed

* **Surface contract**: `check:native:surface` → all 70 stub symbols present on
  the real module (no drift between the vendored `.d.ts` and the addon).
* **Semantics**: the decoder fix from Round 23 holds on the shipped 0.9.5 build —
  400,520 differential comparisons, 0 throws / 0 mismatches.
* **Lifetimes — new gate**: `verify-native-ffi` now compiles and destroys 40,000
  route handles in two phases and compares the RSS growth of each. A per-handle
  leak shows up as linear growth; allocator retention does not. Result:
  phase1 **4.0 MB** → phase2 **0.5 MB** (steady state) — no leak. Gate total 227
  checks.

### 24.5 Hot-path profile (load-only window)

Profiling the compiled server needed care: `bun --cpu-prof` writes on exit, and a
`kill -INT` aimed at the wrapping subshell leaves the server alive (which
produced a first profile that was 322 s of wall clock but only 1.8 s of samples —
idle plumbing dominated the table). The reliable recipe is to own the whole
lifecycle from one Bun process (`Bun.spawn` → wait for `/health` → drive
concurrent load → `SIGINT` → `await exited`). Clean window: 20.2 s, 46,804
samples, **469,956 responses**.

| self% | function | what it is |
| --- | --- | --- |
| 17.1% | `(anonymous)` `[native code]` | Bun's HTTP/async internals |
| 13.0% | `Response` | per-response construction (2.6 s / 470k = ~5.6 µs) |
| 7.4% | bundle `:42` | framework/core request path |
| 4.9% + 4.7% + 3.8% | bundle `:55`, `:42` | app/core code (template + routing) |
| 3.2% (24.2% total) | `b` `:48` | aggregator (lifecycle/handler chain) |
| 2.8% | `get` `[native code]` | header/Map access |
| 2.3% | `encode` `[native code]` | `TextEncoder` — our `toBytes()` on request paths |
| 2.3% | `stringify` | JSON response bodies |
| 2.2% | `u32` `[native code]` | FFI `read.u32` in the packed/route decoders |

Reading: the profile has **no dominant fixable JS wrapper hotspot** — the time is
Bun's HTTP internals, `Response` construction, JSON, and our own byte-level FFI
reads (which are the price of the native decode). Nothing here contradicts the
per-op work; the remaining wins are selection-level, which is where this round
found them. `bench:server:check` (the committed baseline gate) stays green.

### 24.6 Numbers this round

* Linked dev addon: **0.9.5 + x86-64-v3 SIMD**, resolved by the loader
  automatically; `queryPairs`/`aeadEncrypt`/`crc32`/`validateUuid` all native.
* Newly native: EdDSA JWT sign **1.80x** / verify **1.45x**, `crc32` **1.9x**,
  `validateUuid` 1.13x.
* Deliberately still JS, with numbers recorded so nobody "optimizes" them back:
  `validateEmail` (JS 3.6x), `validateIpv4` (JS 1.75x), `cookiePairs` (JS 1.28x),
  `formPairs` (JS 1.14x), `jsonValid` below 256B, `hmacSha256`/`randomToken` on
  napi.
* Gates on the linked addon: `verify` 0 (1,952 tests), `verify:native:ffi`
  **227/227**, `verify:native:route` ✓, smoke 52/52 ×2 modes,
  `bench:server:check` ✓, `check:native:surface` 70/70, handle-lifetime steady
  state.

### 24.7 End-to-end effect of the native stack (linked 0.9.5 + v3 SIMD)

`bun run bench:server` (interleaved native / fallback / raw-bun, 7 routes,
concurrency 32) — every route is faster with castrum live than with
`IGNEX_NATIVE=off`, i.e. the whole selection layer earns its keep:

| route | native rps | fallback rps | native gain |
| --- | --- | --- | --- |
| GET /health | 4,501 | 4,128 | +9.0% |
| POST /api/orders (bulk JSON+schema) | 4,538 | 4,203 | +8.0% |
| GET /api/search (60 params) | 4,547 | 4,274 | +6.4% |
| GET /api/me (30 cookies + session, AEAD) | 4,678 | 4,192 | **+11.6%** |
| GET /api/reports/42 (JWT) | 732 | 714 | +2.6% |
| GET /catalog (120-item template) | 3,463 | 3,182 | +8.8% |
| GET /api/big (256 KB gzip) | 2,611 | 2,458 | +6.2% |

(`/api/reports/42` is ~5.5 ms p50 in BOTH modes — an app-level cost unrelated to
the addon, so its percentage is diluted; `/api/me` is the biggest winner because
it is the AEAD/session route this campaign un-pinned.)

### 24.8 What the sweep deliberately did NOT change

* **`passwordHash`/`passwordVerify`**: `Bun.password` exists and is native, but
  argon2id's cost *is* the feature (per-login, not per-request), and switching the
  JS fallback's algorithm (currently `$scrypt$` PHC) would change the security
  contract — performance is not the axis to tune here.
* **A `cstring` variant of the JSON validator**: the profile shows `TextEncoder`
  at 2.3% self (≈3.2 µs/request average), of which the bulk is
  `jsonValid(toBytes(body))` re-encoding a 15 KB POST body that arrived as bytes.
  A `jsonValidStr` C-ABI symbol (cstring ARG — the engine transcodes in-engine,
  like the validators already do) would remove roughly 4 µs from that route,
  ~0.4% of its 1.02 ms. Measured and deliberately deferred: it needs a castrum
  ABI addition + surface/gate churn for a fraction of a percent.
* **SSE / websockets / multipart / media-type / accept-encoding / gzip / brotli /
  rate limiter / templates / schema validator**: no C-ABI binding exists, so only
  the napi transport can serve them; the audit owns those decisions and reports
  them as "js stays" (Bun's `req.formData()`, `Bun.gzipSync`, `isIP`, Ajv, …).
