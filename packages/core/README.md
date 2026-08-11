# @flux/core

Runtime primitives for flux — the HTTP context, lifecycle, auth, plugins,
validation, and every helper the generated server imports at runtime.

Source-only package (`exports` → `src/index.ts`), imported directly by
`@flux/compiler`'s generated code. This is the **single source of truth** for
runtime behavior; the compiler never duplicates it.

## Module map (`src/`)

Grouped **by use case** into domain folders (each with a pure re-export
`index.ts` barrel). The public surface is `src/index.ts` — a grouped barrel.

| Folder         | Modules                                                              |
| -------------- | -------------------------------------------------------------------- |
| `security/`    | `auth` (requireAuth/optionalAuth/JWT/basic/bearer/token), `session` (signed-cookie + store), `csrf` (double-submit), `crypto` (JWT / cookie signer / CSRF / password hash / AEAD) |
| `http/`        | `context` (`FluxContext` + `createContext`), `cookies`, `headers` (`set`/`applySet`), `request-id`, `body` (lazy parsing), `proxy`, `files` (`sendFile`/`safeJoin`), `sse`, `ws`, `route` (schema-first helpers `get`/`post`/… — subpath `@flux/core/http`), `conditional` |
| `data/`        | `cache` (HTTP cache + `ctx.cache`), `dataloader` (`ctx.loader`), `lru`, `query`, `schema` (Ajv + Standard Schema), `validation` |
| `lifecycle/`   | `lifecycle` (`createApp` + `runLifecycle`), `hooks` (engine + halt semantics), `plugin` (+ `hookToPlugin`), `guard`, `macro`, `derive` |
| `platform/`    | `env` (typed accessors), `config` (`defineConfig` — subpath `@flux/core/config`), `trace`, `cluster`, `jobs`, `errors` (`HTTPError` family) |
| `content/`     | `i18n` (locale negotiation), `template` (Jinja-subset + layouts) |
| `plugins/`     | auth / session / csrf / cors / compression / security / logger / ratelimit factories |
| `types/`       | unified type umbrella (`types/http.ts` + `types/lifecycle.ts`) |

Top-level: `client.ts` (typed fetch client), `openapi.ts` (OpenAPI 3.1 spec
generator), `index.ts` (public barrel).

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
