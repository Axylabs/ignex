# Ignus Architecture

This document explains how the pieces fit together so you can navigate the
codebase and make changes without breaking the AOT contract.

## Monorepo layout

| Package          | Role                                                              | Entry           |
| ---------------- | ----------------------------------------------------------------- | --------------- |
| `@ignus/shared`   | FP toolkit + the **compiler ↔ runtime AOT contract** (`ContextUsage`) | `src/index.ts` |
| `@ignus/native`   | Rust-accelerated primitives + byte-compatible pure-TS fallbacks    | `src/index.ts`  |
| `@ignus/core`     | Runtime primitives: context, lifecycle, auth, plugins, validation — grouped **by use case** into domain folders (see below) | `src/index.ts`  |
| `@ignus/compiler` | AOT compiler pipeline (source-only)                               | `src/index.ts`  |
| `@ignus/cli`      | Developer CLI (scaffold / dev / build / mcp)                       | `src/index.ts`  |
| `@ignus/mcp`      | Model Context Protocol server (agent tools over stdio)            | `src/index.ts`  |
| `packages/app`   | Example application (routes, views, hooks) + benchmarks           | `builder.ts`    |

All packages ship **source-only**: `exports` point at `src/*.ts`, and Bun runs
TypeScript natively. There is no build step for libraries — only `packages/app`
is AOT-compiled.

## The one-way dependency rule

```
shared  ←  native  ←  core  ←  compiler  ←  cli / app
```

- `shared` imports nothing.
- `native` imports nothing from core/shared.
- `core` may import shared + native.
- `compiler` imports core (and shared).
- `cli` imports compiler.
- **Never** let `core` import from `compiler`, or `shared` from anything.

The runtime is the single source of truth. The compiler imports runtime
primitives (`runHooks`, `createContext`, `serializeCookie`,
`errorToResponse`, `ValidationError`, `validateAsync`) into the generated
server — it never duplicates their logic.

## AOT compiler pipeline

`packages/compiler/src` is organized into phases that run in order:

```
discovery → analysis → optimization → precompile → artifacts → codegen → linker
```

Each phase is a focused module under `src/phases/` (large phases are further
split into concern folders — `analysis/` and `codegen/`):

- **discovery** — finds route files (deterministically sorted), classifies
  them by method/path (`products/[id].get.ts` → `GET /products/:id`), and
  reads + parses each one exactly once through the source frontend.
- **analysis/** — lowers discovered sources into `RouteIR`s and computes the
  semantic facts (usage bitmap, response type, hooks, schemas). Split into
  `route-graph.ts`, `conflicts.ts`, `hooks.ts`, `app-config.ts`, `fs.ts` and
  the `runAnalysis` orchestrator in `index.ts`.

Two cross-cutting layers sit directly under `src/`:

- **`frontend/`** — the source layer. `SourceManager` reads + parses every
  file the build touches (routes, app config, hooks) exactly once and retains
  a `SourceFile` (AST included); later phases consume `SourceFile` handles
  instead of re-reading/re-parsing source. `ModuleInfo` is a deprecated alias
  of `SourceFile`.
- **`ir/`** — the route intermediate representation. `lowerRoute` lowers a
  filename + `SourceFile` into a `RouteIR` with four owned sections — `source`
  (immutable filename facts), `analysis` (semantic facts), `decisions`
  (optimizer/precompile output), `codegen` (generated identifiers). Each phase
  reads/writes only its own section.
- **optimization** — constant-response detection, inline eligibility, dead-code
  pruning. Gated by `optimizationLevel` 0–3 presets.
- **precompile** — compiles validators/serializers ahead of time. Both use the
  shared `forEachRouteWithSchema` loop in `schema-loader.ts`; `schema-convert.ts`
  turns Standard-Schema parts into plain JSON Schema (via `toJSONSchema`/`toJsonSchema`
  or zod/valibot) so they can be precompiled instead of falling back to runtime.
- **codegen/** — emits the optimized `__server.js`: native Bun routing, a
  specialized per-route context, `__applySet`/`__finalize`/`__handleError`
  helpers, and the pre/post lifecycle. `generateServer` composes named emission
  stages (`imports.ts` → `header.ts` → `routes.ts` → `routetable.ts` →
  `server.ts`) over a shared `CodegenState`; `identifiers.ts` owns all
  generated-name conventions and `helpers.ts` the dependency-aware helper
  registry.
- **linker** — wires route modules, hooks, and app config together.
- **artifacts** — writes `routes.d.ts`, `client.ts`/`client.d.ts`,
  `openapi.json`, `manifest.json`.

The pipeline itself is composed declaratively in `src/index.ts`: each phase is
a pure function over a `PipelineState`, threaded with `pipe` (sync path) or
`pipeAsync` (async path) from `@ignus/shared`. The whole build reads as:
`validate → discover → analyze → optimize → precompile → artifacts → codegen
→ link → cache`.

The build writes two cache artifacts into `outDir`: `.ignus-cache.json` (the
whole-build fingerprint) and `.ignus-modules.json` (the **persistent module
parse cache** — `frontend/persist.ts` serializes each `SourceFile`'s
`ParseResult`, keyed by content hash, so `SourceManager` rehydrates unchanged
modules instead of re-parsing them on cache-hit regeneration and rebuilds).

### The AST layer (`src/utils/ast/`)

The compiler analyzes route source with `oxc-parser` (with a Bun parser
fallback chain). The analysis layer lives in `src/utils/ast/`:

| File          | Responsibility                                      |
| ------------- | --------------------------------------------------- |
| `ast-types.ts`| Typed, parser-agnostic AST node model (`Node` union)|
| `walk.ts`     | `walk` / `walkUntil` / `walkSome` (+ depth guard)   |
| `parse.ts`    | Parser bridge + content-keyed parse memoization     |
| `handler.ts`  | Route handler extraction (default + named exports)  |
| `usage.ts`    | `ctx.*` usage detection → the specialization bitmap |
| `imports.ts`  | import/export extraction + export classification    |
| `symbols.ts`  | module symbols + intra-module call graph            |
| `purity.ts`   | side-effect analysis for constant hoisting          |
| `constant.ts` | safe, side-effect-free constant evaluation          |
| `response.ts` | response-type inference heuristic                   |
| `config.ts`   | `export const config` extraction (statically)       |

The single parser-specific cast lives in `parse.ts` (`normalizeAst`);
everything downstream is typed against the `Node` union in `ast-types.ts`.

### The AOT contract: `ContextUsage`

`ContextUsage` (in `@ignus/shared`) is a bitmap of which `ctx.*` members a
handler touches (`body`, `query`, `params`, `set`, `loader`, …). The compiler
emits a context that only carries the used members; `EMPTY_USAGE` /
`FULL_USAGE` are the extremes. When you add a new `ctx` member:

1. add the flag to `ContextUsage` (shared),
2. add it to the `USAGE_FLAGS` table in `utils/ast/usage.ts`,
3. gate the context emission on the flag in `codegen.ts`,
4. add a test in `packages/compiler/test/ast.test.ts`.

## Runtime lifecycle

`@ignus/core/src/lifecycle/lifecycle.ts` owns the request pipeline. `runLifecycle`
composes the pre-handler stages (`beforeHandle` …), runs the handler, then the
post-handler stages (`afterHandle` → `mapResponse` → `afterResponse`) as a
`pipeAsync` composition of named stages over a `LifecycleState` carrier. The
generated server imports `runHooks`/`runLifecycle` from `@ignus/core` — there is
**one** implementation, not a compiled copy.

`IgnusContext` (`core/src/http/context.ts`) is the per-request object: read-only
request surface (`req`, `url`, `headers`, `ip`…), mutable `params`/`query`/
`body`/`cookie`/`state`, the `set` outgoing channel, and response builders
(`json`/`text`/`redirect`/`stream`/…). `ctx.set` mutations are applied by the
generated `__applySet` helper. Cookie parsing/serialization, the `set`/
response channel and request-id generation live in sibling modules
(`http/cookies.ts`, `http/headers.ts`, `http/request-id.ts`).

## Core domain layout

`packages/core/src` is grouped **by use case** (not by mechanism). Each folder
has an `index.ts` barrel (pure re-exports) and a `@fileoverview` header:

| Folder        | Use case                                                   | Modules                     |
| ------------- | ---------------------------------------------------------- | --------------------------- |
| `security/`   | Request security & trust                                   | auth, csrf, crypto, session |
| `http/`       | Request/response handling                                  | context, cookies, headers, body, proxy, files, sse, ws, route DSL |
| `data/`       | Data access, caching & validation                          | cache, dataloader, lru, query, schema, validation |
| `lifecycle/`  | Request pipeline & composition                             | hooks, lifecycle, plugin |
| `platform/`  | App runtime infrastructure                                 | env, config, coerce, jobs, durable jobs (`jobs-store.ts` / `jobs-durable.ts`), errors |
| `content/`    | Rendering & localization                                   | i18n, template |
| `plugins/`    | Ready-made `IgnusPlugin` factories                          | cors, security, compression, ratelimit, logger, auth, csrf, session |
| `types/`      | Unified type umbrella (`types/http.ts` + `types/lifecycle.ts`) | — |

`client.ts` and `openapi.ts` stay top-level (consumer-facing). The public
surface is `src/index.ts` — a grouped barrel that re-exports from the domain
folders, so the internal layout never leaks to consumers. Subpath exports:
`@ignus/core/http` → `src/http/route.ts`, `@ignus/core/config` →
`src/platform/config.ts`.

## Maintainability conventions

- **Group by use case.** Files that serve one feature live together; god files
  are split by concern (e.g. `context.ts` → context/cookies/headers/request-id).
  A file exceeding ~400 lines is a signal to split.
- **Barrels are pure re-exports.** Domain `index.ts` files only re-export; all
  logic lives in the sibling modules. Internal imports target the specific
  module (`../http/context`), not the barrel, to avoid import cycles.
- **Single source of truth.** Cross-cutting helpers live in exactly one place:
  `http/conditional.ts` (ETag/If-Modified-Since), `http/headers.ts`
  (hop-by-hop set, `appendVary`, `reWrapResponse`, `stripHopByHopHeaders`),
  `http/cookies.ts` (`writeCookie`), `security/auth.ts`
  (`parseAuthorizationHeader`), `lifecycle/plugin.ts` (`hookToPlugin`),
  `lifecycle/hooks.ts` (`mergeHookArrays`, `mergeLifeCycle`),
  `http/request-id.ts` (request ids), `platform/coerce.ts` (`coerceBoolean`),
  `compiler/validate.ts` (`mergeOptions` — preset application happens once),
  `compiler/phases/schema-loader.ts` (`forEachRouteWithSchema`).
- **Compose with the FP toolkit.** `pipe`/`pipeAsync`/`fold`/`Result` from
  `@ignus/shared` are used where they make control flow explicit (the compiler
  pipeline, `runLifecycle`, `negotiateLocale`, `defineConfig`, session cookie
  decoding). The route DSL is a curried factory (`defineMethod`) so each
  `get`/`post`/… helper stays a one-liner with its own schema bound. Hot-path
  request code stays plain where composition would obscure short-circuiting
  semantics — prefer readability over ceremony.
- **Prune dead code.** Removed paths are deleted, not commented out (e.g.
  `ModuleInfo.callGraph`/`dataFlow`, `RouteIR.signatureHash`/`handlerSize`,
  the legacy `BodyParser` helpers).

## Cache / determinism

The compiler keeps an incremental cache (`.ignus-cache.json`) fingerprinted by
`COMPILER_CACHE_VERSION` in `packages/compiler/src/cache.ts`. **Bump it
whenever generated code changes** — a stale version silently disables the
cache, a stale hash can serve stale output.

## Native acceleration

`@ignus/native` resolves the `castrum` Rust addon when available and falls back
to pure-TS implementations otherwise (never throws). Both paths are locked by
the parity suite in `packages/native/test/native.test.ts`. See
`packages/native/README.md`.
