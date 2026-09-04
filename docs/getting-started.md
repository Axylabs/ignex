# Getting Started

> How to go from zero to a running Ignex API in a few minutes.

Ignex is an AOT-first TypeScript framework for high-performance HTTP APIs on
[Bun 1.4+](https://bun.sh). Routes are files; the compiler turns them into an
optimized `Bun.serve` server with generated types, an OpenAPI spec, and a typed
client.

## 1. Prerequisites

- [Bun](https://bun.sh) ≥ 1.4 (`curl -fsSL https://bun.sh/install | bash`)

That's it. No global install required — the CLI is fetched on demand.

## 2. Create a project

```sh
bunx @ignex/cli@latest create my-api --features auth,openapi,examples
cd my-api
bun install
bun run dev
```

What you get:

- `src/routes/` — file-system routes (`index.get.ts` → `GET /`, `products/[id].get.ts` → `GET /products/:id`)
- `src/app.config.ts` — plugins (debugbar, session, openapi, plus any selected features), lifecycle, and a **typed** `server` config (`ServerConfig` — HTTPS or plain HTTP per the wizard)
- `src/config/env.ts` — validated environment config (a TypeBox schema + `defineEnv`) and `.env.example` derived from it
- `src/lib/auth.ts` + auth routes (register / login / me) when you pass `--features auth`
- `ignex.config.mjs` — compiler profile (optimization level, artifact toggles)
- `vitest.config.ts` + `test/` — a scaffolded integration test

Environment variables are declared in `src/config/env.ts` with a TypeBox
schema (required / optional / default / secret) instead of reading
`process.env` directly. Copy `.env.example` to `.env` and adjust. See
[Config & env](cookbook.md#config--env) for the full API.

`bun run dev` compiles the app, starts the server, and restarts it on every
change (with crash backoff). You'll see a `Native:` line reporting whether the
Rust addon is active:

```
ℹ Native: native (castrum)     # accelerated
ℹ Native: off (pure-TS fallback)  # still fully functional
```

**HTTPS, HTTPS + HTTP/2, or HTTP — you choose at scaffold time.** The create
wizard asks a `Protocol` question (`https` by default; pass `--protocol https2`
for HTTPS + HTTP/2 over TLS, `--protocol http` for plain HTTP/1). The
generated `src/app.config.ts` types its `server` export with the public
`ServerConfig` interface from `@ignex/core`, so every knob is discoverable and
type-checked:

```ts
export const server: ServerConfig = {
  port: env.PORT,
  https: true, // or false for plain HTTP/1
  h2: true, // HTTP/2 over TLS (ALPN) — Bun ≥1.4.1; server.http2: true also works
};
```

With HTTPS, ignex enables TLS at startup. In development it auto-generates a
local certificate (mkcert → openssl fallback) and caches it under
`.ignex/certs`, logging where it came from. With `h2: true`, Bun serves
HTTP/2 on that same TLS port — clients that offer `h2` during ALPN (browsers,
`curl --http2`) get HTTP/2, everyone else gets HTTP/1.1, so existing
HTTP/1.1 tooling keeps working (WebSocket `upgrade()` is HTTP/1.1-only). The
server also logs the base and OpenAPI URLs at boot — with the scheme you chose
(plain HTTP logs `http://…`):

```
[ignex] HTTPS enabled with a locally-trusted dev certificate (mkcert) from …/.ignex/certs.
ignex listening on https://localhost:3000
[ignex] openapi: https://localhost:3000/openapi — API docs UI (spec at https://localhost:3000/openapi.json)
```

- No mkcert/openssl? It warns and **falls back to HTTP/1** — nothing breaks.
- Supply your own certs with `server.tls: { certFile, keyFile }`, or force plain
  HTTP/1 later with `server.https: false` (or `IGNEX_HTTPS=0` for CI/tooling).
- Bun ≥1.4.1 supports HTTP/2 in `Bun.serve` (experimental). HTTP/3 (QUIC) and
  managed public certificates are a different story — put **Caddy** (or
  nginx/Cloudflare) in front for HTTP/3 and auto-provisioned certs.

## 3. Your first route

Routes are files under `src/routes/`; the path and method come from the
filename. Handlers export a **named** binding (`httpGet`) or a **default**
binding — both compile to the same native route table:

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
```

With a path parameter and TypeBox schema (JSON-schema codegen + OpenAPI):

```ts
// src/routes/products/[id].get.ts → GET /products/:id
import { get } from "@ignex/core/http";
import { Type } from "typebox";

export default get(
  {
    params: Type.Object({ id: Type.String() }),
  },
  (ctx) => ctx.json({ id: ctx.params.id }),
);
```

Scaffold a route from the CLI instead of hand-writing it:

```sh
bun run route -- products/[id].get --schema
bun run hook -- require-auth            # named per-route hook
bun run hook -- log-requests --global   # global lifecycle hook
```

## 4. Build, run, and check

```sh
bun run build     # AOT-compile → .ignex/server.js + routes.d.ts, client.ts, openapi.json, manifest.json
bun run start     # run the compiled server
bun run compile   # ALSO emit a standalone Bun executable (.ignex/<serviceName>) — minify + bytecode
bun run typecheck # strict TS check
bun run test      # vitest
```

`ignex build --compile [--binary-outfile NAME]` is the same as `bun run
compile`: the linker emits a self-contained binary (embeds the Bun runtime,
bytecode-compiled, `NODE_ENV=production`) that runs without installing Bun.
`ignex build` is production-shaped by default — dev-only tooling (the
debugbar dashboard and per-request tracing) is eliminated from the artifact
even when the build shell has no `NODE_ENV`; pass `--dev` for a dev-shaped
artifact. Production binary with no `server.tls` configured warns and falls
back to HTTP/1 — terminate TLS at your proxy or set `server.tls` for HTTPS
over TLS.

Diagnose a project without building:

```sh
bunx @ignex/cli doctor --root .
# Runtime: bun 1.4.0
# Native: native (castrum)
# Config: ignex.config.mjs
# Routes: src/routes ✔
# Server: .ignex/server.js not built — run `ignex build`
```

`doctor` exits non-zero when it finds blocking issues, so you can run it in CI
or onboarding scripts. `bunx @ignex/cli info --root .` dumps the same facts
(plus native status) as JSON.

**Shell completions.** `bunx @ignex/cli completions <shell>` prints a
tab-completion script for bash, zsh, fish, PowerShell, or cmd (via clink), e.g.
`source <(bunx @ignex/cli completions bash)`. Install instructions for each
shell are in `packages/cli/README.md`.

## 5. Generated artifacts

Each build emits, next to the server:

| Artifact        | Purpose                                          |
| --------------- | ------------------------------------------------ |
| `routes.d.ts`   | Typed route context (params/query/body/responses) |
| `client.ts`     | Typed HTTP client backed by `createClient`        |
| `openapi.json`  | OpenAPI spec derived from your real schemas        |
| `manifest.json` | Build metadata for tooling                         |

## 6. Where to go next

- [Cookbook](cookbook.md) — recipes for sessions, jobs, i18n, SSE, WebSockets,
  templates, rate limiting, caching, and more.
- [CLI reference](../packages/cli/README.md) — every command and scaffold flag.
- [Example app](../packages/app/README.md) — the reference app exercising the
  full feature set.
- [Architecture](architecture.md) — how the compiler and packages fit together.
