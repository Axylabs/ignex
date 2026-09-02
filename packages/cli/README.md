# @ignex/cli

Developer CLI for ignex: scaffold apps, routes, event flows and deployment
files; watch, build, and diagnose. Modern interactive wizards (arrow keys,
space to toggle, Ctrl+C to cancel) with full non-interactive fallbacks so every
command stays scriptable.

Source-only package — `bin/ignex.js` (`#!/usr/bin/env bun`) imports
`../src/index.ts` directly, matching the monorepo's source-only convention
(Bun runs TS natively). There is **no build step** and no `dist/` requirement.

## Commands

```
ignex create <app-name> [options]   Scaffold a new ignex app (wizard + 22 feature toggles)
ignex route <path> [options]        Scaffold a route + its src/modules business logic
ignex event <kind> <name>           Scaffold event flows (sse | webhook | bus) — wizard
ignex hook <name> [options]         Scaffold a hook (--global for lifecycle)
ignex model <Name> [options]        Scaffold a schema-first model (--fields)
ignex resource <Name> [options]     Scaffold a model + pregenerated CRUD routes
ignex hotroute <Name> [options]     Scaffold a model + hot-cached CRUD split into thin routes + src/modules logic
ignex migrate <action> [options]    Run ninox DB migrations (up/down/status/create)
ignex seed [options]                Run (or scaffold) the DB seed script (src/seed.ts)
ignex dev [root] [options]          Compile + run the dev server (watch; --kill-port)
ignex build [root] [options]        AOT-compile an app with diagnostics
ignex doctor [root]                 Check project health (runtime, native, config, build)
ignex ops <target> [options]        Generate deployment files (dockerfile/compose/caddy/ci) — compose wizard
ignex sdk [options]                 Generate + distribute the app SDK (typed client)
ignex info [root]                   Dump cwd / runtime / native / config as JSON
ignex mcp                           Run the Model Context Protocol server (stdio)
```

Run `ignex --help` for grouped command docs, `ignex <command> --help` for a
single command's flags, and `ignex --version` for the CLI version. `build`/`dev`
print a `Native:` line (native addon vs pure-TS fallback), and `info` includes
the same status in its JSON output.

`ignex create` scaffolds into a folder named `<app-name>` inside the current
directory by default; pass `--root <dir>` to target an explicit parent
directory instead:

```sh
mkdir workspace && cd workspace
ignex create api --root ../ --features auth,openapi
```

Run `ignex create` with no arguments for the interactive wizard: pick the
project name, package manager, and feature set (checkbox multi-select) instead
of typing comma-separated features.

## Routes with business-logic modules (`ignex route`)

`ignex route <path>` scaffolds **two files** by default: the thin route file
(HTTP layer) plus its business-logic module, mirroring the path under
`src/modules/`:

```
src/routes/products/[id].get.ts      # thin HTTP layer
src/modules/products/[id].get.ts     # business logic (handle())
```

The route file calls the module's `handle(ctx)` and wraps the result:

```ts
// src/routes/products/[id].get.ts
import { get } from "@ignex/core/http";
import { handle } from "../../modules/products/[id].get.js";

export default get(async (ctx) => ctx.json(await handle(ctx)));
```

```ts
// src/modules/products/[id].get.ts — implement your logic here
export async function handle(ctx: ModuleContext) {
  const { id } = ctx.params;
  // ... your business logic ...
  return { received: { id }, ok: true };
}
```

This keeps routes thin from the start and gives every endpoint a single,
findable place for its logic. Pass `--no-module` for the classic single-file
route, `--named` for named exports (`export const httpGet`), and `--schema` for
TypeBox validation. Interactive mode asks for the path and (when the path has
no method suffix) the HTTP method.

## Event flows (`ignex event`)

`ignex event` is a wizard (or `ignex event <kind> <name>` non-interactively)
for event-driven features — every flow scaffolds the logic into
`src/modules/` and keeps the route thin:

```sh
ignex event sse orders       # GET /events/orders — SSE stream (server → clients)
ignex event webhook orders   # POST /hooks/orders — receive event data (clients → server)
ignex event bus order        # typed in-process event bus + publish route + consumer
```

- **sse** — `sse()` route + an async-generator producer module
  (`src/modules/events/<name>.get.ts`) that yields `SSEMessage` events.
- **webhook** — a receiver route that parses the JSON body and hands it to
  `handle<Name>Event(payload)` in `src/modules/hooks/<name>.post.ts`.
- **bus** — the wire contract (`src/realtime.ts`), a pre-wired `novaPlugin`
  (`src/realtime.plugin.ts`), `src/lib/events.ts` (typed
  `on`/`emit`/`emitToUser` facade), a publish route (`POST /events/emit.<name>`)
  and an example consumer in `src/realtime/consumers/` that the compiled
  server auto-registers after the hub binds. Pair with the NATS service from
  `ignex ops compose` for cross-service streaming.

## Hot routes (`ignex hotroute`)

`ignex hotroute <Name>` scaffolds the same ninox CRUD as `ignex resource`, but
keeps the **route files thin** (HTTP layer: params/query/status) and moves the
**logic into `src/modules/<plural>/`**, one file per operation, plus a shared
HotCache for the get-one path:

```
src/
  models/<plural>.ts                     # schema-first model
  modules/<plural>/
    <plural>.cache.ts                    # shared HotCache (change-stream invalidated)
    get.ts  list.ts  post.ts  patch.ts  del.ts
  routes/api/<plural>/
    [id].get.ts  [id].patch.ts  [id].del.ts  index.get.ts  index.post.ts
```

Route files must keep the handler inline (the AOT compiler only follows a route
module's own exports), so the modules export plain functions the handlers call.

```sh
ignex hotroute Gig --fields "name:string, price:number"
```

New resources are merged into an existing `src/db.ts` automatically (import,
`defineCollections(...)` member, `createSchema(...)`), and `dbPlugin()` +
`@ignex/ninox`/`typebox` deps are wired like `ignex resource`.

## Scaffold features

`ignex create --features <list>` enables optional scaffolding (default
`openapi,examples,tests`; `all`/`none` also accepted):

- `auth` — full auth route set: `POST /auth/register`, `POST /auth/login`,
  `GET /auth/me`, plus `src/lib/auth.ts` (Ed25519 `authModule()`,
  `createPasswordHasher`, in-memory user store) and the `require-auth` hook.
- `refresh` — adds `POST /auth/refresh` and `POST /auth/logout` on top of
  `auth` (opaque, revocable refresh tokens backed by the session store).
  Requires `auth` (enabled automatically if omitted).
- `middleware` — global hooks scaffold: `src/middleware/` with a custom
  `IgnexPlugin` (`request-id.ts`) + lifecycle `HookFn`s (`log-requests.ts`),
  wired into the `plugins` array and a `lifecycle` export in `app.config.ts`.
- `sessions`, `cors`, `rateLimit`, `security`, `compression`, `logger`,
  `openapi`, `files`, `ws`, `sse`, `cache`, `proxy`, `templates`,
  `env`, `jobs`, `i18n`, `examples`, `tests` — the remaining toggles.

## Diagnostics (`ignex doctor`)

`ignex doctor [root]` checks project health without building:

- **Runtime** — Bun vs Node and version.
- **Native** — whether the Rust addon (`castrum`) is loaded and the active
  backend (`native (castrum)` vs `off (pure-TS fallback)`).
- **Config** — which `ignex.config.*` file is picked up (if any).
- **Routes** — whether the configured routes directory exists.
- **Server** — whether the compiled server entry exists (else: run
  `ignex build`).

It exits non-zero when blocking issues are found, so it can gate CI or
onboarding scripts.

## Hooks

- `ignex hook <name>` scaffolds a named per-route hook to `src/hooks/<name>.ts`
  (reference it via `export const config = { hooks: ["<name>"] }`).
- `ignex hook <name> --global [--stage <stage>]` scaffolds a global lifecycle
  hook and registers it on `app.config.ts`'s `lifecycle` (default stage
  `beforeHandle`) so it runs on every request.

## Dev mode (`ignex dev`)

`ignex dev` compiles the project, spawns the generated server and watches for
changes:

- **Port conflicts** — before the first spawn `ignex dev` checks whether
  another process already holds the port and offers to kill it (interactive),
  or frees it automatically with `--kill-port`. The crash-restart backoff
  message points at the flag too.
- **Auto-restart with backoff** — a crashing server is restarted (250 ms →
  5 s exponential backoff); after 5 rapid crash-on-boot restarts it gives up
  and waits for a file change (e.g. when the port is already in use).
- **No EADDRINUSE races** — the old server is stopped and awaited before the
  new one spawns, so the port is always released first.
- **Stale-build feedback** — a failed rebuild prints that the running server is
  serving the previous build; a successful build prints "server is up to date".
- **`--no-spawn`** compiles + watches only (no server process).
- **`--verbose`** surfaces compiler phase timings and debug logs.
- `ignex build --watch` forwards `--minify` / `--sourcemap` / `--verbose` to the
  compiler and runs the same watch flow.

### Building a standalone binary

`ignex build --compile [--binary-outfile NAME] [--no-bytecode]` also emits a
self-contained Bun executable (runtime embedded, minified, bytecode-compiled,
`NODE_ENV=production`) that runs without installing Bun. Output defaults to
`outDir/<serviceName>`; the path is printed on success.

## Deployment files (`ignex ops`)

`ignex ops <target>` generates deployment files for an ignex backend, targeting
the runtime contract (`PORT`, default 3000; `GET /health`; TLS terminated at the
proxy via `IGNEX_HTTPS=0`):

```
ignex ops dockerfile          Dockerfile (multi-stage standalone binary) + .dockerignore
ignex ops compose             docker-compose.yml + .env.docker — interactive service wizard
ignex ops caddy               Caddyfile (optimized reverse proxy)
ignex ops ci                  GitHub Actions workflow (typecheck/lint/test/build + deploy)
ignex ops docker              all of the above (interactive)
```

Run `ignex ops compose` (or `ignex ops docker`) with no flags to get the
**compose wizard**: pick which infra services to include with checkboxes, then
answer the per-service questions. Every prompt falls back to its default when
stdin isn't a TTY, so CI stays scriptable.

Services (each optimized for ignex):

| Service | Image (default) | Wired env | Used for |
| --- | --- | --- | --- |
| MongoDB | `percona/percona-server-mongodb` | `MONGO_URL` | ninox toolkit data store |
| Redis | `redis:7-alpine` | `REDIS_URL` + `REDIS_PASSWORD` | cache / session stores |
| NATS | `nats:2-alpine` (JetStream) | `NATS_URL` | event streaming / pub-sub |

The app's `depends_on` waits for every selected service to be healthy, and
secrets are written to `.env.docker` (loaded via `env_file`) so they never land
in the committed compose file. Select services via flags for non-interactive
runs:

```sh
ignex ops compose --services mongo,redis,nats --redis-password "$REDIS_PW"
ignex ops compose --no-mongo --redis --nats          # app-only + redis + nats
ignex ops docker --db-user admin --db-password "$DB_PASS" --replica --domain api.example.com
ignex ops docker --yes --db-password "$DB_PASS"      # skip prompts entirely
```

Highlights:

- **Dockerfile** — `oven/bun` builder runs `bun run build --compile --binary-outfile
  <binary>`; a slim `debian:stable-slim` image runs the standalone binary as a
  non-root user with a `wget` healthcheck on `GET /health`. `--private-registry`
  opts into copying `.npmrc`/`.env` for private installs.
- **compose** — `app` (builds the Dockerfile) + the selected infra services,
  each with a healthcheck; MongoDB `--replica` adds a single-node replica set
  (`rs0`) and a one-shot `mongodb-init` service that calls `rs.initiate()`. The
  replica-set member generates a persistent keyFile so `--auth` works with
  `--replSet`, and MongoDB is exposed on host `27017:27017` for local dev.
- **Caddyfile** — reverse proxy with auto TLS, HSTS at the terminator (the app
  deliberately omits it), and no `encode gzip` (the app already compresses).

Run `ignex ops --help` for the full flag reference.

## Shell completions

`ignex completions <shell>` prints a script that enables tab-completion for
commands, flags, and flag values; paths fall through to the shell's own file
completion. The scripts call a hidden `ignex _complete` backend at tab time, so
they always reflect the current command list.

```sh
ignex completions bash        # bash
ignex completions zsh         # zsh
ignex completions fish        # fish
ignex completions powershell  # PowerShell
ignex completions cmd         # cmd.exe (via clink)
```

Enable per shell (each generated script's header repeats these):

```sh
# bash — append to ~/.bashrc
echo 'source <(ignex completions bash)' >> ~/.bashrc

# zsh — add the file to $fpath + compinit, or just source it
source <(ignex completions zsh)

# fish — append to ~/.config/fish/config.fish
ignex completions fish | source

# PowerShell — append to $PROFILE, then reload
ignex completions powershell | Out-File -Append $PROFILE; . $PROFILE

# cmd.exe — requires clink (https://github.com/chrisant996/clink)
ignex completions cmd > %USERPROFILE%\clink\ignex.lua
```

The scripts assume `ignex` is on your `PATH` when you press Tab (they call
`ignex _complete`). If you only use the CLI via `bunx`, add
`alias ignex='bunx @ignex/cli'` (or install it) so completion can invoke the
backend.

## Development

```sh
bun run typecheck      # tsc -p tsconfig.json (types: ["node"])
bun bin/ignex.js --help # run from source
bun run test           # vitest
```

The CLI's `tsconfig.json` uses `types: ["node"]` (it can run under Node ≥ 22)
and is therefore **excluded from the root tsconfig**. Root CI typechecks it
separately via `bun run typecheck:cli`.

> Note: the compiler is bundled at the source level — the CLI imports
> `@ignex/compiler` (`workspace:*`), which is source-only. On a fresh clone,
> `bun install` resolves the workspace deps; no separate build is needed.
