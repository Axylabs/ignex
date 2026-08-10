# @flux/core

Runtime primitives for flux — the HTTP context, lifecycle, auth, plugins,
validation, and every helper the generated server imports at runtime.

Source-only package (`exports` → `src/index.ts`), imported directly by
`@flux/compiler`'s generated code. This is the **single source of truth** for
runtime behavior; the compiler never duplicates it.

## Module map (`src/`)

| Module        | Responsibility                                            |
| ------------- | --------------------------------------------------------- |
| `context.ts`  | `FluxContext` + `createContext` + cookies (`ctx.set`)     |
| `lifecycle.ts`| `createApp` + `runLifecycle` + stage builders             |
| `hooks.ts`    | Hook engine: `composeHooks`, `runHooks`, halt semantics   |
| `http.ts`     | Schema-first route helpers (`get`/`post`/…) — subpath `@flux/core/http` |
| `errors.ts`   | `HTTPError` family + `errorToResponse`                    |
| `auth.ts`     | `requireAuth`/`optionalAuth`/JWT/basic/bearer/token hooks |
| `session.ts`  | signed-cookie + store-backed sessions                     |
| `csrf.ts`     | double-submit CSRF guard                                  |
| `crypto.ts`   | JWT / cookie signer / CSRF / password hash / AEAD         |
| `validation.ts` | email/uuid/ip validators (native-backed)                |
| `schema.ts`   | Ajv + Standard Schema v1 validation, compiled cache       |
| `body.ts`     | lazy body parsing (`ctx.body`)                            |
| `cache.ts`    | HTTP cache headers + `HttpResponseCache` + `ctx.cache`    |
| `dataloader.ts`| per-request `ctx.loader` batching/caching                 |
| `query.ts`    | query string parsing (native-backed)                      |
| `files.ts`    | `sendFile` + `safeJoin` (traversal guard)                 |
| `proxy.ts`    | `proxyRequest` / `forwardRequest`                         |
| `sse.ts`      | SSE helpers                                               |
| `ws.ts`       | `FluxWS` + `createWSHandler`                              |
| `jobs.ts`     | in-process job queue + retry/timeout                      |
| `i18n.ts`     | locale negotiation + interpolation                        |
| `env.ts`      | typed env accessors (`envInt`, `envJson`, `envSecret`…)   |
| `config.ts`   | `defineConfig` (subpath `@flux/core/config`)              |
| `template.ts` | Jinja-subset templating + layouts                          |
| `openapi.ts`  | OpenAPI 3.1 spec generator                                |
| `plugin.ts` + `plugins/` | plugin system + auth/session/csrf/cors/compression/security/logger/ratelimit |
| `macro.ts`    | macro registry (auth/cache/csrf/jwt/session)              |
| `derive.ts`   | context enrichment pipelines                              |
| `trace.ts`    | trace context + spans                                     |
| `cluster.ts`  | multi-core `Bun.serve`                                    |
| `client.ts`   | typed fetch client (base for generated clients)           |
| `lru.ts`      | LRU cache wrapper                                         |
| `types.ts`    | central types (`HttpMethod`, `TSchema`, `LifeCycleStore`, `FluxContext`-adjacent) |

## The `ctx.set` contract

`FluxContext.set` is the outgoing channel. The generated server's `__applySet`
helper merges `set.headers`, serializes `set.cookie`, and applies `set.status`.
Every runtime path that mutates the response goes through it — never write
headers directly in a way that bypasses `set`.

## Development

```sh
bun run test:core      # core test suite
bun run typecheck      # root typecheck includes core
```

See [docs/architecture.md](../../docs/architecture.md) for the one-way
dependency rule and the `ContextUsage` AOT contract.
