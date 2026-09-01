---
name: ignex-core-framework
description: Work inside @ignex/core (packages/core) — the runtime primitives, the route DSL, the lifecycle, security, validation, and plugins that generated servers import. Use when changing runtime behavior, context, or plugins.
---

# ignex: Core framework (`@ignex/core`)

`@ignex/core` is the **single source of truth for runtime behavior** — the
compiler's generated server imports it directly and never duplicates it.
Public surface = `src/index.ts` barrel + documented subpaths
(`@ignex/core/http` = route DSL, `/debug`, `/config`, `/env`, `/jobs`,
`/store`, `/content`, `/openapi`).

## Module map (domain folders — each has a pure re-export `index.ts`)

| Folder | Contents |
| --- | --- |
| `security/` | `auth` (requireAuth/optionalAuth/JWT/basic/bearer), `session` (signed-cookie + store), `csrf` (double-submit), `crypto` (JWT / cookie signer / CSRF / password hash / AEAD) |
| `http/` | `context` (`IgnexContext` + `createContext`), `cookies`, `headers`, `request-id`, `body` (lazy parsing), `proxy`, `files` (`sendFile`/`safeJoin`), `sse`, `ws`, `route` (schema-first `get`/`post`/… — `@ignex/core/http`), `conditional`, `finalize` |
| `data/` | `cache` (HTTP cache + `ctx.cache`), `dataloader` (`ctx.loader`), `lru`, `query`, `schema` (Ajv + Standard Schema), `validation` |
| `lifecycle/` | `lifecycle` (`createApp` + `runLifecycle`), `hooks` (engine + halt semantics + `mergeLifeCycle`), `plugin` (+ `hookToPlugin`) |
| `platform/` | `env` (typed accessors), `config` (`defineConfig` — `@ignex/core/config`), `coerce`, `jobs` (durable + store), `errors` (`HTTPError` family), `sqlite`, `metrics`, `mailer`, `notifier`, `scheduler` |
| `content/` | `i18n` (locale negotiation), `template` (Jinja-subset + layouts) |
| `plugins/` | ready-made `IgnexPlugin` factories: auth-module, auth, session, csrf, cors, compression, security, logger, ratelimit, rbac, native, nova, openapi, debugbar, metrics |
| `debug/` | debugbar + observatory (logs, metrics/Prometheus, SQLite history, leak diagnostics) |
| `types/` | unified type umbrella (`types/http.ts` + `types/lifecycle.ts`) |

Top-level: `client.ts` (typed fetch client), `openapi.ts` (OpenAPI 3.1 spec
generator), `jobs.ts`.

## The `ctx.set` contract

The context is the spine of every request. Read `packages/core/src/http/
context.ts` before touching anything that reads/writes request state — many
helpers rely on the exact `ctx.set` semantics (headers, cache, session,
requestId, locals).

## Conventions

- **Functional composition**: factories (`createApp`, `defineConfig`,
  `createContext`, plugin factories) return plain objects with closures — no
  classes on the public surface. Reuse the FP toolkit from `@ignex/shared`
  (`compose`, `always`, …).
- **Pure functions** in the data/content/platform helpers; side effects
  (sockets, files, timers, env) isolated in dedicated modules.
- **Route DSL** (`http/route.ts`): schema-first `get`/`post`/… helpers — the
  compiled/interpreted router and OpenAPI generation derive from the same
  schemas; keep them in sync.
- New plugins are `IgnexPlugin` factories in `plugins/` with a barrel export.
- `@ignex/core/http` subpath = `src/http/route.ts` — don't move it without
  updating `package.json` exports AND the compiler's generated imports.

## Verify

- `bunx vitest run packages/core/test` (or `bun run test:core`).
- `bun run typecheck` (root tsconfig covers `packages/*/src`).
- After plugin/lifecycle changes: `bun run smoke` + `smoke:fallback`
  (the generated app exercises every user-facing flow).
