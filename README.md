# flux-core

> Work-in-progress TypeScript framework for building high-performance HTTP APIs on **Bun 1.4**, using **native Bun routing** and **ahead-of-time compilation** for maximum performance.

`flux-core` is an AOT-first web framework designed to achieve native-like performance while keeping a TypeScript-friendly developer experience. Routes are written as simple file-system modules, then compiled into an optimized Bun server with generated types, OpenAPI artifacts, precompiled validators, and specialized request handlers.

---

## Table of Contents

- [Overview](#overview)
- [Project Goals](#project-goals)
- [Why Bun 1.4 Native Routing?](#why-bun-14-native-routing)
- [Core Design Principles](#core-design-principles)
- [Feature Overview](#feature-overview)
- [How the Compiler Works](#how-the-compiler-works)
- [Generated Artifacts](#generated-artifacts)
- [Compiler Hardening](#compiler-hardening)
- [Development Workflow](#development-workflow)
- [Documentation](#documentation)
- [What Is Done](#what-is-done)
- [What Is In Progress / Missing](#what-is-in-progress--missing)
- [Roadmap](#roadmap)
- [Current Limitations](#current-limitations)
- [Status](#status)

---

## Overview

`flux-core` is a TypeScript framework and compiler toolchain for building production-oriented HTTP APIs on Bun.

Instead of relying only on a runtime router, `flux-core` compiles your file-based routes into a highly optimized Bun server. The compiler analyzes route files ahead of time, detects context usage, precompiles validation and serialization where possible, and emits a server that uses Bun 1.4’s native routing capabilities.

The project is composed of several workspace packages:

- `@flux/compiler` — AOT compiler pipeline
- `@flux/core` — runtime primitives and HTTP helpers
- `@flux/cli` — developer CLI for scaffolding, building, and dev mode
- `@flux/shared` — shared types, FP core, and compile-time/runtime flags
- `@flux/native` — Rust-accelerated primitives with pure-TS fallbacks
- `packages/app` — example application used for testing and benchmarking
- `scripts/` — benchmarking and OpenAPI client generation utilities

---

## Project Goals

The main goal of `flux-core` is to build a high-performance TypeScript web framework that feels ergonomic while compiling away as much runtime overhead as possible.

### Primary Goals

1. **Native-like performance**
   - Use Bun 1.4 as the primary runtime.
   - Use Bun’s native routing instead of a heavy runtime router.
   - Generate specialized handlers instead of generic middleware chains.

2. **Ahead-of-time compilation**
   - Discover routes at build time.
   - Analyze route files using AST parsing.
   - Inline constant responses where safe.
   - Precompile validators and serializers.
   - Generate optimized server entry code.

3. **File-system routing**
   - Routes are defined by files.
   - Dynamic parameters are expressed using `[param]` syntax.
   - Catch-all parameters are expressed using `[...param]` syntax.
   - HTTP methods are expressed through file suffixes such as `.get.ts`, `.post.ts`, `.del.ts`.

4. **Type-safe APIs**
   - Typed route context.
   - Typed params, query, and body where schemas are provided.
   - Generated route types.
   - Generated client type definitions.
   - OpenAPI generation support.

5. **Production-ready primitives**
   - Lazy body parsing.
   - Structured errors.
   - Schema validation.
   - HTTP caching helpers.
   - File serving.
   - Proxying.
   - SSE.
   - WebSocket helpers.
   - Rate limiting.
   - CORS.
   - Security headers.
   - Compression.
   - Logging.
   - Tracing helpers.

6. **Excellent developer experience**
   - CLI scaffolding.
   - Dev mode with watch and rebuild.
   - Route generation.
   - Project creation.
   - OpenAPI and client generation scripts.

---

## Why Bun 1.4 Native Routing?

`flux-core` targets Bun 1.4 because Bun provides a high-performance JavaScript/TypeScript runtime with built-in primitives that are ideal for an AOT framework.

The compiler emits a server that uses **Bun’s native routing** instead of implementing a custom regex trie or runtime route matcher.

This gives several advantages:

- Lower routing overhead.
- Faster parameter extraction.
- Less generated runtime code.
- Better alignment with Bun’s internal optimizations.
- Simpler generated server entry.
- Static, dynamic, and wildcard routes handled directly by Bun.

In short: route matching is delegated to Bun, while `flux-core` focuses on compile-time optimization, typed context, validation, serialization, and production HTTP primitives.

---

## Core Design Principles

### 1. Compile-time over runtime

Whenever possible, decisions are made during compilation:

- Route discovery.
- Route path parsing.
- HTTP method extraction.
- Context usage detection.
- Constant response detection.
- Handler inlining eligibility.
- Validator precompilation.
- Serializer precompilation.
- OpenAPI artifact generation.
- Type artifact generation.

### 2. File-system routing

Routes are defined by convention:

```txt
src/routes/index.get.ts        → GET /
src/routes/health.get.ts       → GET /health
src/routes/products/[id].get.ts → GET /products/:id
src/routes/files/[name].get.ts  → GET /files/:name
```

### 3. "Most DX" hello world

The handler can be exported as a **default** or a **named** binding — the compiler
discovers either, and the route path + method still come from the filename:

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@flux/core/http";

export default get(() => "Hello World");
```

```ts
// Same route, named export
import { get } from "@flux/core/http";

export const httpGet = get(() => "Hello World");
```

Both compile to the same optimized `Bun.serve` route table. Scaffold either style
with the CLI:

```sh
flux create my-api --yes        # generates hello-world routes (named-export style)
flux route products/featured --named   # export const httpGet = ...
flux route about                # export default ...
```

**DataLoaders are available by default** on every request context — batching,
caching, and dedup for N concurrent `load(key)` calls into a single underlying
batch call:

```ts
// src/routes/users.get.ts
export const httpGet = get(async (ctx) => {
  const users = ctx.loader(async (ids) => fetchUsers(ids)); // one batch call
  const [a, b] = await Promise.all([users.load(1), users.load(2)]);
  return ctx.json({ a, b });
});
```

---

## How the Compiler Works

`@flux/compiler` runs a Svelte-style phased pipeline over your route files and emits a
single Bun server entry plus typed/OpenAPI artifacts:

1. **Discovery** — scans `routesDir`, parses each module to an AST (oxc-parser with
   Bun fallbacks), and extracts imports, exports, symbols, and handlers.
2. **Analysis** — lowers filenames into `RouteIR`s, detects constant responses,
   context usage, dead/ambiguous routes, and resolves hooks and `app.config`.
3. **Optimization** — marks inline-eligible handlers and deduplicates identical
   constant responses (per HTTP method).
4. **Precompilation** — emits Ajv standalone validators (`.cjs`) and
   `fast-json-stringify` serializers (`.mjs`).
5. **Codegen** — emits the server as a deterministic string with
   dependency-aware pruning of unused runtime helpers (tracked by the
   `Emitter`), conservative handler inlining, and route-specialized contexts.
6. **Linker** — writes the entry raw, or `Bun.build`s it when `minify`/`sourceMap`
   is requested.
7. **Artifacts** — `routes.d.ts`, `client.d.ts`, `openapi.json`, `manifest.json`.

Every phase reports recoverable problems as **structured diagnostics** (stable code,
file location, code frame) instead of silently swallowing them. See
[`packages/compiler/README.md`](./packages/compiler/README.md) for the full API,
options, and diagnostic-code reference.

## Generated Artifacts

`build`/`dev` write into `outDir` (default `.flux`):

| Artifact | Description |
| --- | --- |
| `server.js` | The generated Bun server entry. |
| `routes.d.ts` | Typed route map consumed by the generated client. |
| `client.d.ts` + `client.ts` | Typed `FluxClient` types + a real `createApiClient` implementation. |
| `openapi.json` | OpenAPI 3.1 document derived from route metadata and real schemas. |
| `manifest.json` | Per-route metadata (path, method, usage, hotness, constants). |
| `validators/*.cjs` | Precompiled Ajv validators per schema part. |
| `serializers/*.mjs` | Precompiled response serializers per status code. |
| `.flux-cache.json` | Incremental build fingerprint. |

## Compiler Hardening

The compiler ships with an enterprise-grade diagnostics system, dependency-aware
codegen pruning, a structured `CompileResult` API, and an incremental build cache.
`buildAsync()` is the canonical entry point; the sync `build()` path is deprecated
(it cannot precompile validators/serializers, minify, or emit source maps).

## Development Workflow

```sh
bun install             # install workspace dependencies
bun run verify          # typecheck + typecheck:cli + lint + test (what CI runs)
bun run test:coverage   # tests + enforced coverage thresholds
bun run build           # AOT-compile the example app
bun run smoke           # boot the generated server + assert routes
bun run dev             # compile + watch the generated server
```

Individual gates:

```sh
bun run typecheck       # tsc --noEmit (strict)
bun run typecheck:cli   # CLI typecheck (separate tsconfig, types:["node"])
bun run lint            # oxlint + biome check
bun run test            # full vitest suite (all packages)
```

## Documentation

- [docs/architecture.md](docs/architecture.md) — how the packages and the AOT
  compiler fit together, the one-way dependency rule, and the `ContextUsage`
  contract.
- [docs/adding-a-feature.md](docs/adding-a-feature.md) — step-by-step guides
  for plugins, hooks, routes, native functions, `ctx` members, and compiler
  passes.
- [docs/release-process.md](docs/release-process.md) — cache-version bumps,
  tagging, publishing.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, quality gates, commit conventions.
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities.
- Per-package READMEs: `packages/core`, `packages/native`, `packages/cli`,
  `packages/app`, `packages/shared`, `packages/compiler`.

## Feature Overview

`flux-core` is a **complete, Rust-accelerated backend framework** on Bun. It combines an AOT compiler with a rich runtime:

| Area | What's included |
| --- | --- |
| Routing | File-system routing, AOT-compiled into Bun's native router; dynamic/catch-all params; auto HEAD/OPTIONS; 404/405. |
| Middleware | Lifecycle hooks, guards, plugins (`cors`, `compression`, `security`, `logger`, `rateLimit`). |
| Validation | Precompiled Ajv standalone validators (body/query/params/headers/cookie) + runtime Standard-Schema + JSON-Schema fallback. |
| Serialization | Precompiled `fast-json-stringify` response serializers per status code. |
| Auth & security | JWT (HS256), Basic/Bearer auth hooks, signed cookies, CSRF guard, password hashing (argon2id/scrypt), AEAD encryption, HMAC. |
| Sessions | Stateless signed-cookie sessions + store-backed sessions (in-memory store), rolling expiry, middleware + plugin. |
| Templates | Jinja-compatible rendering (native minijinja) with registries, directories, and `withLayout` composition. |
| i18n | Message catalogs, `Accept-Language` negotiation, `withI18n` middleware + `ctx.t`. |
| HTTP primitives | Lazy body parsing (JSON/text/form/multipart/upload), query/cookie parsing, ETags, media types, SSE, WebSockets, static files + ranges, proxying. |
| Caching | Cache-Control builder, ETag/conditional requests, response cache with stale-while-revalidate. |
| Observability | Request IDs, tracing spans + headers, access logging (pino). |
| Jobs | In-process task queue with `schedule`/`every`/`once`, concurrency, retries (`withRetry`), timeouts (`withTimeout`). |
| Config & env | dotenv loading, typed `defineConfig`, typed env accessors. |
| Lifecycle | `createApp` with plugin/lifecycle composition and graceful shutdown (`stop`). |
| Client | Generated typed client (`client.ts`) backed by a runtime `createClient`. |
| Artifacts | `routes.d.ts`, `client.d.ts` + `client.ts`, `openapi.json` (real schemas), `manifest.json`. |

### Native acceleration (`@flux/native`)

The Rust NAPI addon (`castrum`) accelerates proven hot paths — hashing (FNV-1a 64/CRC-32), crypto (JWT, cookie signing, CSRF, HMAC, AEAD, argon2, random tokens), HTTP parsing (query/cookie/multipart/media-type/ETag), SSE/WebSocket framing, compression, JSON validation/patch, template rendering and input validation.

- Every function falls back to a **byte-compatible pure-TS implementation**, so flux works everywhere; native is a pure acceleration layer.
- Check `isNativeAvailable()` from `@flux/native` for observability; override the resolved addon with `FLUX_NATIVE_PATH`.
- Native is used **only where proven faster** (castrum's `proven` registry) — the framework never regresses on non-proven surfaces.

## What Is Done

- ✅ AOT compiler pipeline (discovery → analysis → optimization → precompile → codegen → linker → artifacts) with content-keyed **parse memoization** (kills the 5× re-parse).
- ✅ Native-accelerated hashing for cache fingerprints and content keys.
- ✅ Real optimization metadata (`inlinedHandlers`, `deduplicatedHandlers`, `eliminatedRoutes`) persisted across incremental cache hits.
- ✅ Documented `optimizationLevel` presets (0–3) with explicit-knob override.
- ✅ Hook module analysis (`FLX_HOOK_MISSING`), per-module call graphs / data flow, and route hotness scoring.
- ✅ OpenAPI generation wired to real route schemas (request body, params, headers, status-keyed responses).
- ✅ Generated typed client implementation (`client.ts`).
- ✅ Runtime security suite (JWT, auth hooks, sessions, CSRF, signed cookies, password hashing, AEAD).
- ✅ Templates (minijinja native / JS fallback), i18n, env/config, background jobs, graceful shutdown, typed client.
- ✅ Core bug fix: `ctx.set` is now exposed, so cookies/headers set via `ctx.cookie`/`ctx.set` are serialized into responses.
- ✅ Core bug fix: plugin `onResponse` hooks no longer run on raw (non-`Response`) handler results.

## What Is In Progress / Missing

- ⏳ **Persistent parse cache across builds** — in-build memoization is done; a disk-persisted metadata cache is future work.
- ⏳ **Durable background jobs** — the job queue is in-process only; an optional file/SQLite-backed store is planned.
- ⏳ Standard-Schema build-time codegen (currently validated at runtime).
- ⏳ OAuth2 / third-party providers on top of the JWT/Basic primitives.

## Roadmap

1. **Persistent compile cache** — serialize minimal per-module metadata (imports/exports/symbols) keyed by content hash.
2. **Durable jobs** — optional SQLite/file-backed queue store + worker hooks.
3. **Schema-first runtime** — standard-schema build-time compilation and native JSON-schema where it wins.
4. **i18n catalog loading** — JSON directory loader alongside TS catalogs.
5. **Publish** — `@flux/native` + `castrum` binaries for all major platforms.

## Current Limitations

- The native addon (`castrum`) must be installed for native acceleration; the pure-TS fallbacks are always functional.
- Password hashes are KDF-specific (argon2id native / `$scrypt$` fallback) — a hash created on one path verifies only on a path that supports its format.
- Templates: the pure-TS fallback supports the common Jinja subset; full Jinja features require the native minijinja renderer.
- Schema validation/serialization for Standard-Schema parts falls back to runtime (no build-time codegen yet).

## Status

Functional and tested end-to-end. The AOT compiler, CLI (`build`/`dev`/scaffold), runtime
primitives, security suite, templates, i18n, jobs, config, client, and native
acceleration layer are all implemented. Tests live in `packages/{native,core,compiler,app,cli}/test`.
and `packages/cli/test`; see the roadmap sections above for planned work.