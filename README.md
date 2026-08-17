# ignex

> Work-in-progress TypeScript framework for building high-performance HTTP APIs on **Bun 1.4**, using **native Bun routing** and **ahead-of-time compilation** for maximum performance.

`ignex` is an AOT-first web framework designed to achieve native-like performance while keeping a TypeScript-friendly developer experience. Routes are written as simple file-system modules, then compiled into an optimized Bun server with generated types, OpenAPI artifacts, precompiled validators, and specialized request handlers.

---

## Quick Start

```sh
bun create ignex my-api --features auth,openapi,examples   # or: bunx @ignex/cli@latest create my-api …
cd my-api && bun install && bun run dev
```

Routes are files under `src/routes/` — the path and method come from the
filename. See [docs/getting-started.md](docs/getting-started.md) for the full
walkthrough and [docs/cookbook.md](docs/cookbook.md) for recipes.

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

`ignex` is a TypeScript framework and compiler toolchain for building production-oriented HTTP APIs on Bun.

Instead of relying only on a runtime router, `ignex` compiles your file-based routes into a highly optimized Bun server. The compiler analyzes route files ahead of time, detects context usage, precompiles validation and serialization where possible, and emits a server that uses Bun 1.4’s native routing capabilities.

The project is composed of several workspace packages:

- `@ignex/compiler` — AOT compiler pipeline
- `@ignex/core` — runtime primitives and HTTP helpers
- `@ignex/cli` — developer CLI for scaffolding, building, and dev mode
- `create-ignex` — the `bun create ignex` / `npm create ignex` entry point
  (thin shim that forwards to `@ignex/cli create`)
- `@ignex/shared` — shared types, FP core, and compile-time/runtime flags
- `@ignex/native` — Rust-accelerated primitives with pure-TS fallbacks
- `packages/app` — example application used for testing and benchmarking
- `scripts/` — benchmarking and OpenAPI client generation utilities

---

## Project Goals

The main goal of `ignex` is to build a high-performance TypeScript web framework that feels ergonomic while compiling away as much runtime overhead as possible.

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

`ignex` targets Bun 1.4 because Bun provides a high-performance JavaScript/TypeScript runtime with built-in primitives that are ideal for an AOT framework.

The compiler emits a server that uses **Bun’s native routing** instead of implementing a custom regex trie or runtime route matcher.

This gives several advantages:

- Lower routing overhead.
- Faster parameter extraction.
- Less generated runtime code.
- Better alignment with Bun’s internal optimizations.
- Simpler generated server entry.
- Static, dynamic, and wildcard routes handled directly by Bun.

In short: route matching is delegated to Bun, while `ignex` focuses on compile-time optimization, typed context, validation, serialization, and production HTTP primitives.

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
import { get } from "@ignex/core/http";

export default get(() => "Hello World");
```

```ts
// Same route, named export
import { get } from "@ignex/core/http";

export const httpGet = get(() => "Hello World");
```

Both compile to the same optimized `Bun.serve` route table. Scaffold either style
with the CLI:

```sh
ignex create my-api --yes        # generates hello-world routes (named-export style)
ignex route products/featured --named   # export const httpGet = ...
ignex route about                # export default ...
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

`@ignex/compiler` runs a Svelte-style phased pipeline over your route files and emits a
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

`build`/`dev` write into `outDir` (default `.ignex`):

| Artifact | Description |
| --- | --- |
| `server.js` | The generated Bun server entry. |
| `routes.d.ts` | Typed route map consumed by the generated client. |
| `client.d.ts` + `client.ts` | Typed `IgnexClient` types + a real `createApiClient` implementation. |
| `openapi.json` | OpenAPI 3.1 document derived from route metadata and real schemas. |
| `manifest.json` | Per-route metadata (path, method, usage, hotness, constants). |
| `validators/*.cjs` | Precompiled Ajv validators per schema part. |
| `serializers/*.mjs` | Precompiled response serializers per status code. |
| `.ignex-cache.json` | Incremental build fingerprint. |
| `.ignex-modules.json` | Persistent per-module parse cache (content-hash keyed). |

### Developer experience & automations

- **`@ignex/mcp`** — a Model Context Protocol server exposing `build`, `route`,
  `info`, `doctor`, `openapi`, and `dev` as agent tools over stdio. Launch it with
  `ignex mcp` and point an MCP client (Claude, Copilot, Codex, …) at it to scaffold,
  compile, and inspect projects without hand-running commands.
- **`ignex create`** now scaffolds the production optimization profile
  (`optimizationLevel: 3`, precompiled validators/serializers, all artifact
  generation, context specialization) so new projects start from the tuned defaults.
- **`ignex route --schema`** offers to install `@sinclair/typebox` when missing.
- **`scripts/new-package.ts`** scaffolds a new workspace package in seconds.

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

- [docs/getting-started.md](docs/getting-started.md) — **start here**: create a
  project, write a route, run dev/build/doctor.
- [docs/cookbook.md](docs/cookbook.md) — copy-paste recipes for sessions, jobs,
  i18n, SSE, WebSockets, templates, rate limiting, caching, proxies, and more.
- [docs/architecture.md](docs/architecture.md) — how the packages and the AOT
  compiler fit together, the one-way dependency rule, and the `ContextUsage`
  contract.
- [docs/router.md](docs/router.md) — the interpreted router
  (`createRouter` + `createApp({ router })`): Bun-native runtime routing,
  guarded lifecycle, and the reply path shared with AOT.
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

`ignex` is a **complete, Rust-accelerated backend framework** on Bun. It combines an AOT compiler with a rich runtime:

| Area | What's included |
| --- | --- |
| Routing | File-system routing, AOT-compiled into Bun's native router; dynamic/catch-all params; auto HEAD/OPTIONS; 404/405. Interpreted apps get the same native routing via `createRouter()` (see [docs/router.md](docs/router.md)). |
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

### Native acceleration (`@ignex/native`)

The Rust NAPI addon (`castrum`) accelerates proven hot paths — hashing (FNV-1a 64/CRC-32), crypto (JWT, cookie signing, CSRF, HMAC, AEAD, argon2, random tokens), HTTP parsing (query/cookie/multipart/media-type/ETag), SSE/WebSocket framing, compression, JSON validation/patch, template rendering and input validation.

- Every function falls back to a **byte-compatible pure-TS implementation**, so ignex works everywhere; native is a pure acceleration layer.
- Check `isNativeAvailable()` from `@ignex/native` for observability; override the resolved addon with `IGNEX_NATIVE_PATH`.
- Native is used **only where proven faster** (castrum's `proven` registry) — the framework never regresses on non-proven surfaces.

## What Is Done

- ✅ AOT compiler pipeline (discovery → analysis → optimization → precompile → codegen → linker → artifacts) with content-keyed **parse memoization** (kills the 5× re-parse).
- ✅ **Persistent per-module parse cache across builds** — `SourceFile` parse results (AST included) are persisted to `.ignex-modules.json` keyed by content hash; cache-hit artifact regeneration and full rebuilds rehydrate unchanged modules instead of re-parsing.
- ✅ Native-accelerated hashing for cache fingerprints and content keys.
- ✅ Real optimization metadata (`inlinedHandlers`, `deduplicatedHandlers`, `eliminatedRoutes`) persisted across incremental cache hits.
- ✅ Incremental cache integrity — companion artifacts (validators/serializers/artifacts) are verified on cache hits, so stale/missing outputs trigger a rebuild.
- ✅ Documented `optimizationLevel` presets (0–3) with explicit-knob override.
- ✅ Hook module analysis (`IGN_HOOK_MISSING`), per-module call graphs / data flow, and route hotness scoring.
- ✅ **Standard-Schema build-time codegen** — parts exposing `toJSONSchema` (or zod/valibot vendors) are converted to JSON Schema and precompiled into Ajv standalone validators + `fast-json-stringify` serializers (and emitted in OpenAPI); unconvertible parts fall back to runtime with `IGN_STANDARD_SCHEMA_RUNTIME`.
- ✅ OpenAPI generation wired to real route schemas (request body, params, headers, status-keyed responses).
- ✅ Generated typed client implementation (`client.ts`).
- ✅ **Durable background jobs** — `JobStore` (file-backed JSONL, plus `bun:sqlite`-backed when available) and a durable queue with claim/lease, crash-recovery via lease expiry, retries with backoff, recurring interval jobs, and `onComplete`/`onFailed`/`onRetry` hooks.
- ✅ **i18n JSON catalog loading** — `loadCatalogDir` / `createI18nFromDir` read `locales/*.json` (incl. namespaced `en/errors.json`) alongside TS catalogs; `withI18n` middleware alias.
- ✅ Runtime security suite (JWT, auth hooks, sessions, CSRF, signed cookies, password hashing, AEAD).
- ✅ Templates (minijinja native / JS fallback), i18n, env/config, background jobs, graceful shutdown, typed client.
- ✅ **MCP server + automation** — `@ignex/mcp` exposes `build`/`route`/`info`/`doctor`/`openapi`/`dev` tools over stdio, launched via `ignex mcp`; scaffolded `ignex create` projects now ship the production optimization profile.
- ✅ Core bug fix: `ctx.set` is now exposed, so cookies/headers set via `ctx.cookie`/`ctx.set` are serialized into responses.
- ✅ Core bug fix: plugin `onResponse` hooks no longer run on raw (non-`Response`) handler results.

## What Is In Progress / Missing

- ⏳ OAuth2 / third-party providers on top of the JWT/Basic primitives.

## Roadmap

1. **Publish** — `@ignex/native` + `castrum` binaries for all major platforms; publish `@ignex/mcp`.
2. **OAuth2 providers** — authorization-code flow, provider registry, PKCE, token refresh on top of the JWT/Basic primitives.
3. **Schema-first runtime** — deepen Standard-Schema vendor coverage (more converters, native JSON-schema where it wins).
4. **i18n catalog hot-reload** — watch `locales/` in dev mode.

## Current Limitations

- The native addon (`castrum`) must be installed for native acceleration; the pure-TS fallbacks are always functional.
- Password hashes are KDF-specific (argon2id native / `$scrypt$` fallback) — a hash created on one path verifies only on a path that supports its format.
- Templates: the pure-TS fallback supports the common Jinja subset; full Jinja features require the native minijinja renderer.
- Standard-Schema build-time conversion covers schemas that expose a JSON-schema converter (`toJSONSchema`/`toJsonSchema`) or the zod/valibot vendors; other vendors are validated/serialized at runtime (`IGN_STANDARD_SCHEMA_RUNTIME`).
- The SQLite job store requires `bun:sqlite`; the file-backed store works everywhere.

## Status

Functional and tested end-to-end. The AOT compiler (with persistent parse caching and
Standard-Schema codegen), CLI (`build`/`dev`/scaffold`/`mcp`), runtime primitives,
security suite, templates, i18n, durable jobs, config, client, native acceleration
layer, and the MCP server are all implemented. Tests live in
`packages/{native,core,compiler,app,cli,mcp}/test`.