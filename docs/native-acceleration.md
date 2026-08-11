# Native acceleration (`@flux/native` × castrum)

flux-core is Rust-accelerated through the **castrum** NAPI addon
(`/home/adeel/poc/bun-rust-runtime-bench`, pinned as an `optionalDependencies`
`file:` entry in `packages/native/package.json`). The `@flux/native` package is
the single, typed bridge: every native primitive ships with a **byte-compatible
pure-TS fallback**, so flux behaves identically with or without Rust. Native is
purely an acceleration layer — importing it **never throws**.

---

## How it works

```
┌───────────────────────────────────────────────────────────────┐
│  @flux/core  /  @flux/compiler  /  apps  (generated servers)   │
│      │  imports                                                   │
│      ▼                                                           │
│  @flux/native  (wrapper + *Fallback per function)              │
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
  an empty module). `FLUX_NATIVE_PATH` overrides resolution (a `.node` path is
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
| `FLUX_NATIVE_PATH` | Override the addon (a `.node` path or module specifier). |
| `FLUX_NATIVE` | `off` disables the addon even when installed (parity debugging); unset/`auto` uses it when present. |

## What's wired today (measured — native where it wins)

**Native is used (wins or parity, measured with `bun scripts/native-bench.ts`):**

| Area | Core module | Native primitive(s) | Measured |
| --- | --- | --- | --- |
| Hashing | `data/cache.ts`, `compiler/utils/hash.ts` | `fnv1a64` | **~8x** ✓ |
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
| Query | `data/query.ts` | `queryPairs` → JS | **x0.87** (native loses) |
| Cookies | `http/cookies.ts` | `cookiePairs` → JS | **x0.46** (native loses) |
| Form bodies | `http/body.ts` | `formPairs` → JS | **x0.97** (native loses slightly) |
| Multipart | `http/body.ts` | Bun `req.formData()` | **Bun wins 4-5x** at 64-512KB (native x0.21-0.24) |
| SSE | `http/sse.ts` | `sseEncode` → JS | parity+ (native fine on large data) |
| ETag | `etag` | JS crc32 | parity (x0.92) |
| Conditional 304 | `http/conditional.ts` | `createConditionalRequest` → JS | parity (native x1.14) |
| Accept negotiation | `createAcceptNegotiator`, `parseAcceptEncoding` | JS | parity |
| Media type | `parseMediaType` | JS | native marked @deprecated (slower) |

> The native exports above remain available for apps that batch large inputs
> (where FFI amortizes). **Exception — do NOT use the native BATCH APIs
> (`queryParseBatchPacked` etc.) under Bun canary**: they are unreliable (see
> the "Batch APIs" note below). The wrapper picks the fastest stable
> implementation per primitive; behavior is identical either way (parity is
> the contract).

## Castrum fixes made for flux compatibility

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

**Exposed in `@flux/native` (available for apps/plugins, not yet wired into
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
`FluxPlugin` that embeds castrum's Rust **8-stage ingress pipeline** (trust /
IP, CORS, rate-limit, body-guard, JSON-schema, cookies/query) as an `onRequest`
stage. When native is unavailable the plugin is a **complete no-op** (safe to
mount everywhere); when available it short-circuits with the pipeline's
terminal response (204 CORS preflight, 429, 413, 400/422) before the app
handler runs.

```ts
import { nativePreflight } from "@flux/core";

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

The bridge itself is `@flux/native` `createNativePipeline(options)` →
`NativePipeline` (guarded, caches the module + pipeline, and normalizes
castrum's outcome into a small `NativePreflightOutcome`). Any native failure
resolves to a non-terminal outcome — the addon can never break a request.

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
  the exact native contract flux relies on. Keep it in sync with the installed
  castrum version (see matrix below).

## castrum ↔ flux compatibility matrix

| flux feature | castrum contract (pinned) |
| --- | --- |
| Rust primitives | `fnv1a64`, `crc32`, `jwtSign/Verify`, `queryParsePacked`, `cookieParsePacked`, `formParsePacked`, `TemplateRenderer`, `SchemaValidator`, `etag`, `multipartParse`, `wsFrame*`, `sseEncode`, `gzip/brotli`, `hmacSha256`, `aead*`, `passwordHash/Verify` |
| Route manager | `createPipeline` (TS integration layer) |
| Entry normalization | `mod.rust ?? mod` (Bun namespace vs Node flat) |

`@flux/native` pins `castrum` via `optionalDependencies` (`file:` path).
Compatibility releases should bump castrum's minor version and add a
`test/compat/flux-contract.test.ts` in the castrum repo asserting this exact
surface, so the contract is guarded by castrum's own CI.

## Running the parity suite

```bash
# Fallback mode (no addon installed) — this is the default CI path:
bun run test:native

# Real-addon mode (build castrum first, then point FLUX_NATIVE_PATH at the .node):
FLUX_NATIVE_PATH=/home/adeel/poc/bun-rust-runtime-bench/castrum.linux-x64-gnu.node \
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
`jsonValidBatchPacked`, …) are **not wired into flux**. Measured on
Bun `1.4.0-canary.1+827475e21` + castrum 0.8/0.9 they are **nondeterministic**:
the returned Buffer can read corrupt (head shows a valid count yet a DataView
read throws "Out of bounds access") and Bun can hard-crash inside
`_tide_enter_transient`. Isolated calls work; specific module/call arrangements
fail. Repro committed at `bun-rust-runtime-bench/scripts/repro-flux-batch.ts`
(Bun only). **Do not wire these until root-caused** (investigate on stable Bun +
Node). Scalar packed parsers (`queryParsePacked` etc.) are byte-identical to JS
but slower per-op (0.46-0.97x) — JS stays the scalar path.

## Rate limiting (2026-08-11)

- `@flux/native` `createRateLimiter` — native sharded fixed-window limiter with
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

- `@flux/native` `initNative({ threads })` — idempotent, never throws; warms
  the rayon pool + forces addon init at boot. `createApp.init()` calls it, so
  `serve()` pays the load-time cost once instead of lazily on the first request
  (the documented "sacrifice load time for runtime" trade).

