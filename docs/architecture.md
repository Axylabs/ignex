# Flux Architecture

This document explains how the pieces fit together so you can navigate the
codebase and make changes without breaking the AOT contract.

## Monorepo layout

| Package          | Role                                                              | Entry           |
| ---------------- | ----------------------------------------------------------------- | --------------- |
| `@flux/shared`   | FP toolkit + the **compiler ↔ runtime AOT contract** (`ContextUsage`) | `src/index.ts` |
| `@flux/native`   | Rust-accelerated primitives + byte-compatible pure-TS fallbacks    | `src/index.ts`  |
| `@flux/core`     | Runtime primitives: context, lifecycle, auth, plugins, validation  | `src/index.ts`  |
| `@flux/compiler` | AOT compiler pipeline (source-only)                               | `src/index.ts`  |
| `@flux/cli`      | Developer CLI (scaffold / dev / build)                            | `src/index.ts`  |
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
discovery → analysis → optimization → precompile → codegen → linker → artifacts
```

Each phase is a focused module under `src/phases/`:

- **discovery** — finds route files, classifies them by method/path
  (`products/[id].get.ts` → `GET /products/:id`).
- **analysis** — parses each module (memoized), builds the route graph, and
  computes the `RouteDef` (usage bitmap, response type, hooks, schemas).
- **optimization** — constant-response detection, inline eligibility, dead-code
  pruning. Gated by `optimizationLevel` 0–3 presets.
- **precompile** — compiles validators/serializers ahead of time.
- **codegen** — emits the optimized `__server.js`: native Bun routing, a
  specialized per-route context, `__applySet`/`__finalize`/`__handleError`
  helpers, and the pre/post lifecycle.
- **linker** — wires route modules, hooks, and app config together.
- **artifacts** — writes `routes.d.ts`, `client.ts`/`client.d.ts`,
  `openapi.json`, `manifest.json`.

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

`ContextUsage` (in `@flux/shared`) is a bitmap of which `ctx.*` members a
handler touches (`body`, `query`, `params`, `set`, `loader`, …). The compiler
emits a context that only carries the used members; `EMPTY_USAGE` /
`FULL_USAGE` are the extremes. When you add a new `ctx` member:

1. add the flag to `ContextUsage` (shared),
2. add it to the `USAGE_FLAGS` table in `utils/ast/usage.ts`,
3. gate the context emission on the flag in `codegen.ts`,
4. add a test in `packages/compiler/test/ast.test.ts`.

## Runtime lifecycle

`@flux/core/src/lifecycle.ts` owns the request pipeline. `runLifecycle`
composes the pre-handler stages (`beforeHandle` …), runs the handler, then the
post-handler stages (`afterHandle` → `mapResponse` → `afterResponse`). The
generated server imports `runHooks`/`runLifecycle` from `@flux/core` — there is
**one** implementation, not a compiled copy.

`FluxContext` (`core/src/context.ts`) is the per-request object: read-only
request surface (`req`, `url`, `headers`, `ip`…), mutable `params`/`query`/
`body`/`cookie`/`state`, the `set` outgoing channel, and response builders
(`json`/`text`/`redirect`/`stream`/…). `ctx.set` mutations are applied by the
generated `__applySet` helper.

## Cache / determinism

The compiler keeps an incremental cache (`.flux-cache.json`) fingerprinted by
`COMPILER_CACHE_VERSION` in `packages/compiler/src/cache.ts`. **Bump it
whenever generated code changes** — a stale version silently disables the
cache, a stale hash can serve stale output.

## Native acceleration

`@flux/native` resolves the `castrum` Rust addon when available and falls back
to pure-TS implementations otherwise (never throws). Both paths are locked by
the parity suite in `packages/native/test/native.test.ts`. See
`packages/native/README.md`.
