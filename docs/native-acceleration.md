# Native acceleration (`@ignex/native` × castrum)

ignex is Rust-accelerated through the **castrum** addon, published on npm as
`castrum` (pinned via `optionalDependencies: { "castrum": "^0.9.0" }` in
`packages/native/package.json`; the local dev checkout lives at
`/home/adeel/poc/bun-rust-runtime-bench` and is wired with `IGNEX_NATIVE_PATH`).
The `@ignex/native` package is the single, typed bridge over the SAME cdylib's
two transports: **bun:ffi C-ABI (primary under Bun)** and **Node-API
(fallback)**. Every native primitive ships with a **byte-compatible pure-TS
fallback**, so ignex behaves identically with or without Rust. Native is purely
an acceleration layer — importing it **never throws**.

---

## How it works

```
┌───────────────────────────────────────────────────────────────┐
│  @ignex/core  /  @ignex/compiler  /  apps  (generated servers)   │
│      │  imports                                                   │
│      ▼                                                           │
│  @ignex/native  (wrapper + *Fallback per function)              │
│      │  getFfi() (bun:ffi C-ABI) → getNative() (NAPI) → JS       │
│      ▼                                                           │
│  castrum .node — SAME binary, TWO transports:                   │
│    • bun:ffi C-ABI (`castrum_*` extern "C"): PRIMARY on Bun      │
│    • NAPI (napi-rs `require`): fallback (Node / stateful classes)│
└───────────────────────────────────────────────────────────────┘
```

- `packages/native/src/ffi.ts` binds the **C-ABI fast path**: `bun:ffi`
  `dlopen`s the resolved `.node` (via `loader.getAddonPath()`) and binds the hot
  `castrum_*` symbols (`~10-20ns` crossing vs `~100-350ns` NAPI). A bind-time
  self-test asserts every C-ABI op matches the NAPI output byte-for-byte and
  disables ffi on any mismatch (`IGNEX_FFI_MODE=ffi` makes failures loud).
  `runtime.ts` `nativeFor()` returns a Proxy that prefers C-ABI for covered ops
  and falls through to NAPI for stateful classes (`SchemaValidator`,
  `TemplateRenderer`, `ConditionalRequest`, …) and Node.
- `packages/native/src/loader.ts` loads the castrum **`.node` NAPI surface**
  with `require()`/`process.dlopen` (Node-API modules cannot be ESM-`import`ed
  in Bun). The binary is located from the installed `castrum` package directory
  (registry `node_modules/castrum`, or the local workspace `file:` checkout via
  `IGNEX_NATIVE_PATH`), **bypassing the tsconfig `paths` mapping**
  that would otherwise hijack a bare `import("castrum")` at runtime (Bun honors
  `paths` — a bare import resolved to the `vendor/castrum.d.ts` stub and loaded
  an empty module). `IGNEX_NATIVE_PATH` overrides resolution (a `.node` path is
  required, a module specifier is imported). `isNativeAvailable()` reports
  whether the addon loaded.
- Each module captures `const native = getNative()` at import; wrappers call
  `native.fn(...)` / `new native.Class(...)` when present, else the
  `*Fallback`. Buffer→`Uint8Array` is normalized via `toPlain()` so deep-equality
  tests hold on both paths. `loadCastrumModule()` loads the castrum TS entry for
  the route-manager (`createPipeline`) bridge.
- **Rule:** a native path must produce byte/behavior-identical output to its
  fallback. If it can't (different ETag format, different negotiation
  semantics), the fallback is updated to match the native (RFC-correct)
  semantics — never both divergent.

## Feature flags

| Env | Effect |
| --- | --- |
| `IGNEX_NATIVE_PATH` | Override the addon (a `.node` path or module specifier). |
| `IGNEX_NATIVE` | `off` disables the addon even when installed (parity debugging); unset/`auto` uses it when present. |
| `IGNEX_FFI_MODE` | `auto` (default: bun:ffi on Bun, NAPI otherwise) · `ffi` (force bun:ffi; throws on bind/self-test failure) · `napi` (force NAPI). |

## 2026-08-14 — C-ABI transport, batch stability, task-group

**C-ABI is now the PRIMARY native transport under Bun; NAPI is the fallback.**
The castrum cdylib exports `#[no_mangle] extern "C"` symbols (`rust/ffi.rs`)
that Bun JIT-compiles to direct native calls (~10-20ns crossing) vs ~100-350ns
for Node-API. Measured: `fnv1a64` crossing ~100ns vs ~300ns NAPI (~5×); the
`fnv1a64` wrapper is x33 vs fallback (was x11.9 on NAPI). Re-selection found no
flips needed — already-native ops (hash/crypto/etag) got amplified by C-ABI,
while pair-parse/validators stay JS for single small inputs (the JS regex beats
even a C-ABI crossing; the win for those is batching / the task-group).

**Native batch is stable and the winners are wired.** The 2026-08-11
"unreliable under Bun canary" concern does NOT reproduce on the current runtime:
a fresh 12-op stability probe (`scripts/bench-batch.ts --probe`) passes 40/40
per op — no corrupt buffers, no crash (the original repro was a script bug:
wrong unpacker for the flat `crc32BatchPacked` wire). The batch FFI entry points
expose the measured winners — `signCookie` (n≥4), `verifyCookie` (n≥4),
`hmacSha256` (n≥4), `hmacSha256Verify` (n≥16), `csrfVerify` (n≥16), plus
`fnv1a64`/`jsonValid` — with thresholds from `bench/results/batch-selection.json`.
The JS `batch` facade and the `runTasks` task-group wrapper were removed
(2026-08-17, cleanup): castrum dropped the C-ABI symbol and the wrappers had no
production consumers — they degraded to per-op JS loops. The raw `*BatchPacked`
FFI entry points remain and are what `scripts/bench-batch.ts` measures.

**Pair-parse regression fixed.** Core pair parsing previously routed N≥4 inputs
through the native batch, which measures SLOWER than the JS scalar parser at
every batch size — the scalar path is used exclusively. The batch pair-parse
entry points and the `parseQueries`/`parseCookies` wrappers were removed
(2026-08-17, cleanup); `parseQuery`/`parseCookieString` remain.

**Pure-TS parity fix.** `hmacSha256`/`hmacSha256Verify` fallbacks now use the
native 64-hex contract on every backend (previously Bun→hex but Node→raw, so
pure-JS sign→verify was broken).

### 2026-08-14 (later) — median-driven FFI re-selection (`FFI_WINS`)

`scripts/bench-ffi.ts` measures the **real C-ABI path** (ffi op + required JS
unpack) against the exact JS fallback the wrapper would otherwise run, using
the **median of 5 interleaved trials** for noise stability. This exposed a gap:
several ops that castrum's NAPI-based `select-native` measured as JS wins were
already covered by the C-ABI surface but hard-wired to JS in ignex. Under the
~10-20ns C-ABI crossing (vs ~100-350ns NAPI) those flip to wins.

Proven median gains (reproduced across repeated runs) → wired via an `FFI_WINS`
override in `packages/native/src/runtime.ts` (applies only while the C-ABI
transport is live; NAPI/Node keep the castrum decision, where they lose):

| op | median ratio vs JS | JS path it replaces |
|---|---|---|
| `fnv1a64` | ~38-46× | pure-TS loop (was already native) |
| `jsonValid` | ~2.0-2.1× | `JSON.parse` |
| `validateIpv6` | ~1.6-2.1× | `node:net` `isIP` |
| `hmacSha256` | ~1.4-1.5× | `Bun.CryptoHasher` |
| `randomToken` | ~1.3-1.3× | `crypto.getRandomValues` |
| `etag` | ~1.08-1.14× | `crc32` + hex |

Ops that stay on JS **even on C-ABI** (median-measured): `queryPairs`/`cookiePairs`/
`formPairs` (~0.3-0.6× — the packed-unpack cost dominates), `validateEmail`/
`validateUuid`/`validateIpv4` (~0.1-0.3× — tight JS regexes), `crc32` (~0.68× —
`Bun.hash.crc32` SIMD wins). Note: `scripts/native-bench.ts` reports a misleading
"queryPairs native x1.54" — that's a false positive (both sides are the same JS
fallback, differing only in the string→bytes conversion); `bench-ffi.ts` measures
the true C-ABI path.

### 2026-08-14 (later) — full native surface benchmark (`scripts/bench-native.ts`)

`bench-native.ts` measures the rest of the `@ignex/native` surface (JSON Schema
validation, the compiled-once stateful classes, and the scalar crypto/codec ops
that go through NAPI on ignex) with the same median method. Findings:

- **JSON Schema validation — the native fast-gate was a REGRESSION, now fixed.**
  Core's `nativeFastAccept` re-serialized the already-parsed body
  (`JSON.stringify`) then re-parsed it in the native engine — measuring
  **0.01–0.06× vs validating the parsed object with Ajv directly (12–100×
  slower)** at every doc size. `core/src/data/schema.ts` now routes **parsed
  objects straight to Ajv** (the proven-fast path); native is only attempted
  when the input is already raw bytes/JSON string (where native parse+validate
  wins for large docs). All fast-gate parity tests still pass.
- **`createAcceptNegotiator` — wired to native.** It was hard-wired to the JS
  engine despite castrum `opImpl` = native and a measured **~1.7–1.9× median
  win** on the compiled-once `negotiate` call. Now native-backed (try/catch →
  JS fallback). NOTE: native wins on the steady-state call; constructing
  per-request measures ~0.5× — compile once and reuse (the "compiled
  negotiator" contract).
- **Already-wired native winners (verified):** `jwtSign` (~1.3×), `jwtVerify`
  (~3.6×), `passwordHash` (~1.3×), `aeadDecrypt` (~2.6×), `brotliCompress`
  (~3×), `brotliDecompress` (~12×) — all bound native via `opImpl`.
- **Confirmed JS stays (median-measured):** `conditional` (~0.08×), `rateLimit.check`
  (~0.09× — native only in the ingress pipeline), `templateRender` (~0.38×),
  `sseEncode` (~0.15×), `wsFrameEncode/Decode` (~0.13-0.23×), `wsAcceptKey`
  (~0.63×), `multipartParse` (~0.9×), `parseMediaType` (~0.4×),
  `parseAcceptEncoding` (~0.35×), `jsonPatch` (~0.3×); `gzip` uses `Bun.gzipSync`
  (rust loses to Bun's native). `aeadEncrypt` is parity/noisy (0.87–1.47×) —
  left as-is.
- Artifacts: `scripts/bench-native.ts` (`bun run bench:native:all`),
  `bench/results/native-selection.json`.

## 2026-08-12 — wiring + measured gate decisions

End-to-end measurement (`bun run bench:server`) of the AOT-compiled server
(native-on vs `IGNEX_NATIVE=off`, interleaved median-of-3) shows the current
native integration is **at parity** with fallback (rps ratio ~0.97–1.00, p50
ratio ~0.96–1.02 across all routes) — the native layer neither loses nor wins at
the compiled-server level. All per-op decisions below are therefore made on
micro-benchmark + semantic-fit evidence, not on assumptions.

**Wired this round (safe wins):**

- **Compression plugin threshold fix (the single biggest win).** Bun sets no
  `content-length` on any `Response`, so the plugin's `threshold` pre-check never
  fired and every response (even a 36-byte `/health`) was buffered + compressed —
  under concurrency that path cost **~2.3ms/request**. The plugin now buffers the
  body once, applies the threshold on the REAL size, skips tiny bodies, and sets
  `content-length`. `/health` 3.16ms → 1.02ms (2.7×).
- **Static large responses: compile-once + precompress.** `/catalog` (120-item
  template) and `/api/big` (256KB JSON) were single-thread CPU-bound under
  concurrency (render + gzip serialize on one core); raw-Bun won by precomputing.
  They now render/compress once at module load and serve the cached bytes
  (`content-encoding` set → compression plugin skips). 0.04–0.08× → 0.81–0.87×
  of raw-Bun.
- **Real-workload benchmark:** `bench/real-data.ts` fixtures, 6 real-data app
  routes, `bench/servers/raw-bun-server.ts` (naive baseline), and per-route
  isolated measurement (`scripts/bench-server-routes.ts`). See
  `docs/performance-baseline-2026-08.md` for the full table.

- **Native preflight pipeline is now a default request stage** (`nativePreflight()`
  in the example app, previously opt-in). One castrum FFI call per request enforces
  the default URL/header/query limits before the app handler (and can enforce
  CORS/rate-limit/JSON-schema via `options`). **Bridge fix:** castrum's
  `createPipeline` defaults `readBody: true` — it reads the request body and
  consumes the stream, which breaks the framework's later lazy body reads.
  `createNativePipeline` now forces `readBody: false` (framework owns the body),
  exposed as `NativePipelineOptions.readBody` + the plugin option. No-op without
  the addon; smoke 44/44 in both modes.
- **Body JSON size guard** (`http/body.ts`) now measures the **raw wire bytes**
  captured at parse time instead of re-serializing every parsed body with
  `JSON.stringify` to measure it — free and more correct (whitespace-heavy
  bodies are now correctly rejected; consistent with the `content-length`
  pre-check).
- **Accept-Language locale matcher** (`content/i18n.ts`) precompiles a
  lowercased-tag → locale `Map` once per `createI18n` (was re-lowercasing the
  supported list + allocating `Object.keys(catalogs)` on every request).

**Measured and NOT wired (gate decisions):**

- **Rust structured-log writer — not built.** Spike (Bun): `JSON.stringify` of
  the 6-field access-log payload is **0.26µs**; `pino.info` full line is **0.76µs**;
  `new Date().toISOString()` is **0.40µs**. A Rust kv→JSON writer must pack the
  fields + cross FFI + return a buffer — realistically **≥0.5–0.8µs** — so it
  cannot beat `JSON.stringify` for small payloads (FFI marshaling alone exceeds
  the whole JS cost). Rust would only win for large/nested payloads, which the
  access-log path never produces. pino stays; no regression risk.
- **castrum `SchemaValidator` — not wired into runtime Ajv.** Measured: ajv
  accepts `{"id":"5"}` for `type: number` (coerces to 5), castrum `fast_schema`
  **rejects** it (string ≠ number). The framework's Ajv is configured with
  `coerceTypes/removeAdditional/useDefaults`, so the native zero-DOM validator
  (validate-only, no mutation) is semantically incompatible as a drop-in or a
  pre-gate — it would reject requests the framework currently accepts and
  transforms. Throughput is also not a win on the interpreted path (native
  ~1.69µs vs ajv ~0.04µs on already-valid objects). **Recommendation:** expose a
  per-schema "pure validation" opt-out of coercion; only then route those
  schemas through `createSchemaValidator`.
- **Native batch pair parsing — kept on JS (fresh 2026-08-14).** Scalar
  `queryPairs` / `cookiePairs` / `formPairs` win (x0.65–0.96 on single inputs),
  and the batched `*BatchPacked` pair parsers ALSO lose to the JS scalar parser
  at every batch size (batch/js ≈ 0.16–0.66 in `bench/results/batch-selection.json`).
  Core `parseQueries`/`parseCookies` therefore use the scalar path (the old
  threshold-4 batch wiring was removed as a regression).

## What's wired today (measured — native where it wins)

> **The selection table (`packages/native/src/selection.ts`) is the single
> authoritative source for which implementation each op binds to.** The tables
> below are a human summary; when they disagree with the table, the table wins.
> Flipping an op is a one-line edit to `SELECTION` — no framework code changes,
> and every consumer (including the unified `backend` facade) picks it up.

**Native is used (wins or parity, measured with `bun scripts/native-bench.ts`):**

| Area | Core module | Native primitive(s) | Measured |
| --- | --- | --- | --- |
| Hashing | `data/cache.ts`, `compiler/utils/hash.ts` | `fnv1a64` (C-ABI) | **x33** ✓ (2026-08-14; x6.74 on NAPI 2026-08-11) |
| Crypto | `security/*` | `hmacSha256`, `jwtSign/Verify`, `signCookie/Verify`, `csrfToken/Verify`, `passwordHash/Verify`, `aeadEncrypt/Decrypt`, `randomToken` | proven wins (argon2 ~18x, csrf ~13x, cookie-sign ~9x) |
| Compression | `plugins/compression.ts` (native buffered gzip) | `gzipCompress` | native zlib-rs |
| Templates | `content/template.ts` | `renderTemplate`/`createTemplate` (minijinja) | compiled renderer |
| Validation | `data/validation.ts` | `validateEmail/Uuid/Ipv4/Ipv6` | parity+ |
| JSON Schema | opt-in `createSchemaValidator` | `SchemaValidator` (large/batch) | native |
| Route manager | `plugins/native.ts` (`nativePreflight`, opt-in) | `createNativePipeline` (ingress pre-flight) | native pipeline |
| Rate limiting (opt-in) | `plugins/ratelimit.ts` (`native: true`) | `createRateLimiter` (Rust fixed-window) | see note below |
| Eager init | `createApp.init()` | `initNative()` (rayon pool + dlopen at boot) | removes first-request latency |

**Deliberately on the fast pure-TS path** (measured with the current addon on
large ≥128-byte inputs — a single napi FFI crossing + packed-buffer unpack is
**slower than plain JS** for these small operations):

| Area | Core module | Wrapper | Measured (native : JS) |
| --- | --- | --- | --- |
| Query | `data/query.ts` | `queryPairs` → JS | **x0.96** (native loses) |
| Cookies | `http/cookies.ts` | `cookiePairs` → JS | **x0.65** (native loses) |
| Form bodies | `http/body.ts` | `formPairs` → JS | **x0.88** (native loses slightly) |
| Multipart | `http/body.ts` | Bun `req.formData()` | **Bun wins 4-5x** at 64-512KB (native x0.21-0.24) |
| SSE | `http/sse.ts` | `sseEncode` → JS | **x0.28** (native FFI marshal loses) |
| ETag | `etag` | JS crc32 | parity (x0.92) |
| Conditional 304 | `http/conditional.ts` | `createConditionalRequest` → JS | **x0.08** (native per-call construction loses ~12x) |
| Accept negotiation | `createAcceptNegotiator`, `parseAcceptEncoding` | JS | parity |
| Media type | `parseMediaType` | JS | native marked @deprecated (slower) |

> The raw native batch FFI entry points (`*BatchPacked`) remain available for
> apps that batch large inputs (where FFI amortizes); the JS `batch` facade and
> the `runTasks` task-group wrapper were removed (2026-08-17, cleanup). The
> scalar wrappers pick the fastest stable implementation per primitive; parity
> is the contract.

## Castrum fixes made for ignex compatibility

- **WebSocket accept key (bug):** castrum's `WS_MAGIC` GUID was
  `258EAFA5-E914-47DA-95CA-5AB5DC11BE85` (wrong). Fixed to the RFC 6455 GUID
  `258EAFA5-E914-47DA-95CA-C5AB0DC85B11` in `rust/payload/websocket.rs` (and the
  JS baseline) + unit test; addon rebuilt.
- **UUID validation parity:** castrum's `validate_uuid` accepts **version-4
  UUIDs only**; the TS fallback regex now matches (was `[1-5]`).
- **`randomToken`** returns hex-string bytes (not raw bytes) — wrapper decodes,
  not hex-encodes.
- **Raw-class surface:** the `.node` exposes napi *classes* (`ConditionalRequest`,
  `AcceptNegotiator`, `SchemaValidator`, `TemplateRenderer`) — the `create*`
  factories are TS-client-only. Bridges construct the classes directly.

**Exposed in `@ignex/native` (available for apps/plugins, not yet wired into
core default paths):**

- `createAcceptNegotiator` — RFC 7231 negotiation (specificity → q → order).
  Core `content/i18n.ts` was NOT rewired because its base-language matching
  (`en-US` → `en`) is a deliberate feature native doesn't provide.
- `createSchemaValidator` — returns `null` when native is unavailable (core
  keeps Ajv). Native is proven fastest for **large schemas / batch**; Ajv wins
  for small one-off docs, so don't route every doc through it.
- `multipartParse`, `etag`, `parseMediaType`, `mediaTypeMatches`,
  `parseAcceptEncoding`, `gzip/brotli`, `wsFrame*`, `jsonValid/jsonPatch` —
  exposed; core intentionally keeps Bun-native / streaming paths where they're
  already optimal.

## Route manager (the native pre-flight pipeline)

`plugins/native.ts` exports `nativePreflight(options)` — an opt-in
`IgnexPlugin` that embeds castrum's Rust **8-stage ingress pipeline** (trust /
IP, CORS, rate-limit, body-guard, JSON-schema, cookies/query) as an `onRequest`
stage. When native is unavailable the plugin is a **complete no-op** (safe to
mount everywhere); when available it short-circuits with the pipeline's
terminal response (204 CORS preflight, 429, 413, 400/422) before the app
handler runs.

```ts
import { nativePreflight } from "@ignex/core";

const app = createApp({
  plugins: [
    nativePreflight({
      options: {
        cors: { allowOrigin: ["https://app.example.com"] },
        rateLimit: { limit: 120, windowMs: 60_000 },
      },
    }),
  ],
  handler: (ctx) => new Response("hello"),
});
```

The bridge itself is `@ignex/native` `createNativePipeline(options)` →
`NativePipeline` (guarded, caches the module + pipeline, and normalizes
castrum's outcome into a small `NativePreflightOutcome`). Any native failure
resolves to a non-terminal outcome — the addon can never break a request.

### 2026-08-13 — typed stages + measured activation decisions

The pipeline's dormant stages are now first-class, **typed** and **tested**
through the bridge (`packages/native/test/ingress-stages.test.ts` proves
rate-limit → terminal 429 and CORS preflight → 204/403 end-to-end):

- `nativePreflight` now accepts top-level `rateLimit` and `cors` conveniences
  (plus a typed `options: NativeIngressOptions`), merged into the single
  ingress option bag:

  ```ts
  nativePreflight({
    rateLimit: { limit: 120, windowMs: 60_000 },
    cors: { allowOrigin: ["https://app.example.com"] },
  });
  ```

- **Rate limiting — single owner.** The pipeline's fixed-window stage and the
  `rateLimit` plugin's `native: true` both use Rust fixed-window limiters; do
  NOT enable both for the same budget or requests are double-charged. Prefer
  the pipeline (`nativePreflight({ rateLimit })`) for IP-based fixed-window;
  use the `rateLimit` plugin only for custom `keyGenerator`s or the
  sliding-window/token-bucket algorithms (TS-only).
- **CORS — split by design.** The pipeline answers OPTIONS preflight entirely
  in Rust (terminal 204 echoing the allowed origin + baked security headers,
  403 for denied origins). The OK-path `access-control-*` echo stays with the
  JS `cors()` plugin (dynamic origins / expose headers / max-age). Plugin
  order matters: the pipeline short-circuits preflight only when
  `nativePreflight` runs before `cors()` in the plugin array.
- **Schema validation — deliberately NOT moved into the pipeline.** The app
  already routes the heavy bulk route through the native one-pass
  `createSchemaValidator.derive` in the handler (`routes/api/orders.post.ts`)
  — native validation without `JSON.parse`. Moving it into the pipeline's
  `schema` stage would require `readBody: true` (buffering the body in the
  pipeline and handing it to the framework), which reworks the lazy-body
  contract and risks streaming uploads — for a saving of only the extra FFI
  crossing. Non-goal; the per-route native derive pattern is the stable choice.

## Adding a function

Follow `docs/adding-a-feature.md` section D: implement the fallback, export
wrapper + `*Fallback`, add parity vectors to
`packages/native/test/native.test.ts`, and (for core wiring) a core test that
holds with and without the addon. Only wire a native path when its output is
**proven identical** (see Performance notes).

## 2026-08-21 — castrum sync: lean native-stack responder + hot-path ports

Synced the latest castrum working-tree changes into `@ignex/native`:

- **Header-packing fast paths** (`ingress.ts`, synced from castrum's
  `gatherRawHeadersPacked`): a plan selecting no headers short-circuits to the
  shared empty block; a CORS-only plan on a non-preflight request returns a
  **cached origin block** (the packed block is a pure function of the typically
  constant `Origin` — no per-request UTF-8 encode, no scratch write); a
  cookie+cors plan on a request with no `Cookie` header reuses the same cached
  block, and the already-fetched cookie is handed down to the general path
  (no second `headers.get('cookie')`). Pre-encoded header names + the shared
  per-header size guards (`MAX_COOKIE_HEADER_BYTES` / `MAX_SMALL_HEADER_BYTES` /
  `MAX_XFF_HEADER_BYTES`) now match castrum's single policy.
- **u32-halves i64 decode** (`decodeVerdict`): `rateResetMs`/`retryAfterMs` are
  read as two `getUint32` halves instead of `getBigUint64` — no per-read BigInt
  boxing (~10ns/read off the hot path; bit-identical result).
- **`NativeRoute.runParts(query, cookie, body)`**: the compiled handlers' hot
  path packs the route frame from pre-encoded bytes (new
  `packRouteFramePartsLength`/`packRouteFramePartsInto` wire helpers) — no
  per-request frame object; `run(frame)` now delegates to the same core. The
  compiler emits `runParts(...)` for eligible routes, and
  `parseQuery`/`parseCookies` are exposed on the compiled route.
- **Lean native-stack responder** (`nativeRouteHandler` + the router `native`
  route kind, synced from castrum's `routes/native.ts` + router `native` spec):
  a route whose plan is only parse+verdict (parseQuery/parseCookies/
  requireJsonBody/validateBody) runs ONE native call with NO CORS/rate-limit/
  security/IP/metadata envelope — 400 for non-JSON under `requireJsonBody`, 422
  for schema failure, 413 for an oversized body, then the responder builds the
  2xx from the decoded snapshot. Measured in castrum ~580ns cheaper per request
  than the full-pipeline responder (+34% RPS at the HTTP level).

The fastest path is the default: `IGNEX_FFI_MODE=auto` binds the C-ABI
(`bun:ffi`) transport on Bun, the compiled routes get the native prelude by
default (`nativeRoutes` on), and the native-preflight pipeline runs the direct
C-ABI `createNativeIngress` when the framework owns the body.

### 2026-08-21 (later) — usage-only native prelude (castrum-aligned query/cookie parse)

The per-route native prelude now fires for **any** route that reads query or
cookies — not just validated routes. A schema-less route like
`for (const [k, v] of ctx.query)` used to parse in JS via `URLSearchParams`
(~5.7µs for a 20-param query); it now runs the Rust parse in ONE native call
and seeds `ctx.query` with `NativeQueryParams` (`packages/core/src/data/query.ts`)
— a read-only URLSearchParams-compatible facade over the native pairs
(iteration, `.get`/`.has`/`.getAll`/`.size`/`.toString`/`.forEach`, `null` on
miss for `?? default` parity) with ZERO URLSearchParams construction
(~1.4µs total, ~4× cheaper). `ctx.cookie` seeds from the native pairs via the
standard lazy cookie jar. When the addon is absent the lazy getters stay —
byte-parity preserved. This is the same move castrum's router makes (its
`/api/users` bench route parses query+cookies natively at ~90k RPS vs ~48k for
the JS `URLSearchParams` path on this host).

## Performance notes

- Only use castrum primitives that beat the JS/Bun baseline (`rust.*` proven
  registry). **Skip the `@deprecated` ones** — native is *slower* than JS for:
  `jsonParse` (~5×), `crc32` (~3.7×), `urlEncode/Decode`, `brotli*`,
  scalar `parseMediaType`, `httpDate`, batch `templateRender`,
  `base64Encode`, `hexEncode`, `urlResolve`/`urlEncodeQuery`, and `jsonPatch`
  is marginal.
- Winners worth wiring: validators, HMAC/JWT-verify, argon2, AEAD, multipart,
  WS frames, query/cookie/form/http parsers, `jsonSumIds`, `fnv1a64`,
  `jsonValid`, the compiled instances (`ConditionalRequest`,
  `AcceptNegotiator`, `SchemaValidator` for large schemas).
- `packages/native/src/vendor/castrum.d.ts` is a hand-maintained **subset** —
  the exact native contract ignex relies on. Keep it in sync with the installed
  castrum version (see matrix below).

## castrum ↔ ignex compatibility matrix

| ignex feature | castrum contract (pinned) |
| --- | --- |
| Rust primitives | `fnv1a64`, `crc32`, `jwtSign/Verify`, `queryParsePacked`, `cookieParsePacked`, `formParsePacked`, `TemplateRenderer`, `SchemaValidator`, `etag`, `multipartParse`, `wsFrame*`, `sseEncode`, `gzip/brotli`, `hmacSha256`, `aead*`, `passwordHash/Verify` |
| Route manager | `createPipeline` (TS integration layer) |
| Entry normalization | `mod.rust ?? mod` (Bun namespace vs Node flat) |

`@ignex/native` pins `castrum` via `optionalDependencies` (`^0.9.0` registry;
workspace `file:` checkouts are dev-only via `IGNEX_NATIVE_PATH`).
Compatibility releases should bump castrum's minor version and add a
`test/compat/ignex-contract.test.ts` in the castrum repo asserting this exact
surface, so the contract is guarded by castrum's own CI.

## Running the parity suite

```bash
# Fallback mode (no addon installed) — this is the default CI path:
bun run test:native

# Real-addon mode (build castrum first, then point IGNEX_NATIVE_PATH at the .node):
IGNEX_NATIVE_PATH=/home/adeel/poc/bun-rust-runtime-bench/castrum.linux-x64-gnu.node \
  bun run test:native
```

The core/compiler/app suites also run green in fallback mode; on machines with
the addon installed they exercise the native paths and assert the same results
(parity is the contract).

## Follow-ups (assessed, deliberately not wired in this pass)

- **Native `etag` in `http/files.ts` / `data/cache.ts`** — would change the
  ETag *value* (crc32 vs current fnv1a64/size-mtime). Kept as-is for stability;
  the 304 decision itself is already native via `http/conditional.ts`.
- **Compression** — `plugins/compression.ts` intentionally streams via
  `CompressionStream`; native `gzip/brotli` are exposed for buffered bodies
  (e.g. compressing cached response bodies) and for apps that opt in.
- **i18n / Accept-Language** — keep the base-language matcher; native
  `AcceptNegotiator` is exposed for apps that want pure RFC negotiation.
- **Runtime JSON Schema** — keep Ajv for small docs; `createSchemaValidator`
  is the opt-in native path for large/batch schemas.
- **`nativePreflight` native-path e2e** — DONE (2026-08-11): the options bridge
  was fixed (they were passed FLAT; castrum's `createPipeline` expects them
  NESTED under `{ options }` — rate-limit/CORS/schema were silently ignored).
  `createNativePipeline` now wraps `{ options }`, the plugin builds the
  pipeline eagerly at `init()`, and `plugins.test.ts` asserts the real-addon
  terminal responses (429 + `ratelimit-*`, CORS preflight 204, oversize 413).

## Batch APIs — stable + wired winners (2026-08-14)

The native **batch/packed** APIs (`*BatchPacked`) are **stable and wired** on the
current runtime. The 2026-08-11 "unreliable under Bun canary" note described
Bun `1.4.0-canary.1+827475e21` + castrum 0.8/0.9; a fresh 12-op stability probe
(`scripts/bench-batch.ts --probe`) passes 40/40 per op on the current build
(Bun `1.4.0-canary.1+b5afcacd7`) with no corrupt buffers and no crash. The
original repro was root-caused to a script bug (wrong unpacker for the flat
`crc32BatchPacked` wire) — castrum `scripts/verify-native-batch.ts` proves
batch==scalar byte-parity.

Measured via `scripts/bench-batch.ts` (thresholds from `bench/results/batch-selection.json`):
- `fnv1a64` batch (n≥16), `jsonValid` batch (n≥16)
- `signCookie` / `verifyCookie` / `hmacSha256` batch (n≥4)
- `hmacSha256Verify` / `csrfVerify` batch (n≥16)
- Pair-parse batches (`queryParse`/`cookieParse`/`formParse`) exist for
  bulk parity but measure slower than the JS scalar at every N — core uses the
  scalar path.

The JS `batch` facade and the C-ABI task-group (`runTasks`) wrapper were removed
(2026-08-17, cleanup) — castrum dropped the task-group symbol and neither had
production consumers.

### Runtime / Bun version pin (2026-08-14)

The local Bun reports `1.4.0` but is actually the canary family
(`1.4.0-canary.1+b5afcacd7`) — it **masquerades as stable**. CI installs the
stable channel via `oven-sh/setup-bun@v2` with `bun-version: latest`, so CI runs
are stable-channel only. **Recommendation:** pin a stable Bun locally
(`bun upgrade --stable` or a pinned install) whenever producing definitive perf
numbers, since benches on the canary build are not directly comparable to CI
stable numbers. No code change is required — this is a tooling/benchmarking note
only.

## Rate limiting (2026-08-11)

- `@ignex/native` `createRateLimiter` — native sharded fixed-window limiter with
  a pure-TS fixed-window fallback (parity-tested). Native is **slower per-check
  standalone** (measured x0.07-0.30 vs the JS Map) — the FFI crossing loses to
  a JS Map lookup. Use the **ingress pipeline** (`nativePreflight` with a
  `rateLimit` config) for native rate limiting in a request path, where one FFI
  call amortizes all eight stages. The standalone native limiter remains useful
  where the state should live in Rust (off the JS heap).
- Core `plugins/ratelimit.ts` accepts `native: true` (opt-in) — identical
  semantics (allow up to `maxRequests` per window, then 429 until reset), with
  the fixed-window state in Rust; transparently falls back without the addon.

## Eager native init (2026-08-11)

- `@ignex/native` `initNative({ threads })` — idempotent, never throws; warms
  the rayon pool + forces addon init at boot. `createApp.init()` calls it, so
  `serve()` pays the load-time cost once instead of lazily on the first request
  (the documented "sacrifice load time for runtime" trade).

