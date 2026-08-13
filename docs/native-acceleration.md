# Native acceleration (`@ignus/native` × castrum)

ignus is Rust-accelerated through the **castrum** NAPI addon
(`/home/adeel/poc/bun-rust-runtime-bench`, pinned as an `optionalDependencies`
`file:` entry in `packages/native/package.json`). The `@ignus/native` package is
the single, typed bridge: every native primitive ships with a **byte-compatible
pure-TS fallback**, so ignus behaves identically with or without Rust. Native is
purely an acceleration layer — importing it **never throws**.

---

## How it works

```
┌───────────────────────────────────────────────────────────────┐
│  @ignus/core  /  @ignus/compiler  /  apps  (generated servers)   │
│      │  imports                                                   │
│      ▼                                                           │
│  @ignus/native  (wrapper + *Fallback per function)              │
│      │  lazy getNative() / isNativeAvailable()                  │
│      ▼                                                           │
│  castrum .node (raw NAPI binary — loaded via require)           │
└───────────────────────────────────────────────────────────────┘
```

- `packages/native/src/loader.ts` loads the castrum **`.node` binary directly
  with `require()`/`process.dlopen`** (Node-API modules cannot be ESM-`import`ed
  in Bun). The binary is located from the castrum package directory (`file:`
  target → `node_modules` symlink), **bypassing the tsconfig `paths` mapping**
  that would otherwise hijack a bare `import("castrum")` at runtime (Bun honors
  `paths` — a bare import resolved to the `vendor/castrum.d.ts` stub and loaded
  an empty module). `IGNUS_NATIVE_PATH` overrides resolution (a `.node` path is
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
| `IGNUS_NATIVE_PATH` | Override the addon (a `.node` path or module specifier). |
| `IGNUS_NATIVE` | `off` disables the addon even when installed (parity debugging); unset/`auto` uses it when present. |

## 2026-08-12 — wiring + measured gate decisions

End-to-end measurement (`bun run bench:server`) of the AOT-compiled server
(native-on vs `IGNUS_NATIVE=off`, interleaved median-of-3) shows the current
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
- **Native batch pair parsing — remains blocked.** Scalar `queryPairs` /
  `cookiePairs` / `formPairs` are measured JS-wins (x0.96 / x0.65 / x0.88); the
  batched `*BatchPacked` APIs (where Rust would win at scale) are unreliable
  under Bun canary (see "Batch APIs" note). Fixing the castrum batch layer and
  wiring `batch.queryParse`/`cookieParse`/`formParse` for bulk endpoints is the
  recommended follow-up.

## What's wired today (measured — native where it wins)

> **The selection table (`packages/native/src/selection.ts`) is the single
> authoritative source for which implementation each op binds to.** The tables
> below are a human summary; when they disagree with the table, the table wins.
> Flipping an op is a one-line edit to `SELECTION` — no framework code changes,
> and every consumer (including the unified `backend` facade) picks it up.

**Native is used (wins or parity, measured with `bun scripts/native-bench.ts`):**

| Area | Core module | Native primitive(s) | Measured |
| --- | --- | --- | --- |
| Hashing | `data/cache.ts`, `compiler/utils/hash.ts` | `fnv1a64` | **x6.74** ✓ (2026-08-11) |
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

> The native exports above remain available for apps that batch large inputs
> (where FFI amortizes). **Exception — do NOT use the native BATCH APIs
> (`queryParseBatchPacked` etc.) under Bun canary**: they are unreliable (see
> the "Batch APIs" note below). The wrapper picks the fastest stable
> implementation per primitive; behavior is identical either way (parity is
> the contract).

## Castrum fixes made for ignus compatibility

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

**Exposed in `@ignus/native` (available for apps/plugins, not yet wired into
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
`IgnusPlugin` that embeds castrum's Rust **8-stage ingress pipeline** (trust /
IP, CORS, rate-limit, body-guard, JSON-schema, cookies/query) as an `onRequest`
stage. When native is unavailable the plugin is a **complete no-op** (safe to
mount everywhere); when available it short-circuits with the pipeline's
terminal response (204 CORS preflight, 429, 413, 400/422) before the app
handler runs.

```ts
import { nativePreflight } from "@ignus/core";

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

The bridge itself is `@ignus/native` `createNativePipeline(options)` →
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
  the exact native contract ignus relies on. Keep it in sync with the installed
  castrum version (see matrix below).

## castrum ↔ ignus compatibility matrix

| ignus feature | castrum contract (pinned) |
| --- | --- |
| Rust primitives | `fnv1a64`, `crc32`, `jwtSign/Verify`, `queryParsePacked`, `cookieParsePacked`, `formParsePacked`, `TemplateRenderer`, `SchemaValidator`, `etag`, `multipartParse`, `wsFrame*`, `sseEncode`, `gzip/brotli`, `hmacSha256`, `aead*`, `passwordHash/Verify` |
| Route manager | `createPipeline` (TS integration layer) |
| Entry normalization | `mod.rust ?? mod` (Bun namespace vs Node flat) |

`@ignus/native` pins `castrum` via `optionalDependencies` (`file:` path).
Compatibility releases should bump castrum's minor version and add a
`test/compat/ignus-contract.test.ts` in the castrum repo asserting this exact
surface, so the contract is guarded by castrum's own CI.

## Running the parity suite

```bash
# Fallback mode (no addon installed) — this is the default CI path:
bun run test:native

# Real-addon mode (build castrum first, then point IGNUS_NATIVE_PATH at the .node):
IGNUS_NATIVE_PATH=/home/adeel/poc/bun-rust-runtime-bench/castrum.linux-x64-gnu.node \
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

## Batch APIs — ⚠️ unreliable under Bun canary (2026-08-11)

The native **batch/packed** APIs (`queryParseBatchPacked`, `cookieParseBatchPacked`,
`formParseBatchPacked`, `crc32BatchPacked`, `sseEncodeBatchPacked`,
`jsonValidBatchPacked`, …) are **not wired into ignus**. Measured on
Bun `1.4.0-canary.1+827475e21` + castrum 0.8/0.9 they are **nondeterministic**:
the returned Buffer can read corrupt (head shows a valid count yet a DataView
read throws "Out of bounds access") and Bun can hard-crash inside
`_tide_enter_transient`. Isolated calls work; specific module/call arrangements
fail. Repro committed at `bun-rust-runtime-bench/scripts/repro-ignus-batch.ts`
(Bun only). **Do not wire these until root-caused** (investigate on stable Bun +
Node). Scalar packed parsers (`queryParsePacked` etc.) are byte-identical to JS
but slower per-op (0.46-0.97x) — JS stays the scalar path.

## Rate limiting (2026-08-11)

- `@ignus/native` `createRateLimiter` — native sharded fixed-window limiter with
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

- `@ignus/native` `initNative({ threads })` — idempotent, never throws; warms
  the rayon pool + forces addon init at boot. `createApp.init()` calls it, so
  `serve()` pays the load-time cost once instead of lazily on the first request
  (the documented "sacrifice load time for runtime" trade).

