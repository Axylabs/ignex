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
- `bench/servers/ingress-server.ts`: zero-copy is now ON by default, bounded by
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
Built `bench/orders-native-trial.ts` in castrum: real 473KB / 5000-item orders
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
- Proof of the concept: `bench/orders-native-trial.ts` (kept as a permanent
  trial-and-error artifact).

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

