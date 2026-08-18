# @ignex/cli

Developer CLI for ignex: scaffold apps, scaffold routes/hooks, watch, and build.

Source-only package — `bin/ignex.js` (`#!/usr/bin/env bun`) imports
`../src/index.ts` directly, matching the monorepo's source-only convention
(Bun runs TS natively). There is **no build step** and no `dist/` requirement.

## Commands

```
ignex create <app-name> [options]   Scaffold a new ignex app (22 feature toggles)
ignex dev [root] [options]          Compile + run the dev server (watch)
ignex build [root] [options]        AOT-compile an app with diagnostics
ignex doctor [root]                 Check project health (runtime, native, config, build)ignex route <path> [options]        Scaffold a single route (--named, --schema)
ignex hook <name> [options]         Scaffold a hook (--global for lifecycle)
ignex model <Name> [options]        Scaffold a schema-first model (--fields)
ignex resource <Name> [options]     Scaffold a model + pregenerated CRUD routes
ignex ops <target> [options]        Generate deployment files (dockerfile/compose/caddy)
ignex info [root]                   Dump cwd / runtime / native / config as JSON
```

Run `ignex --help` for the full option reference. `build`/`dev` print a
`Native:` line (native addon vs pure-TS fallback), and `info` includes the
same status in its JSON output.

`ignex create` scaffolds into a folder named `<app-name>` inside the current
directory by default; pass `--root <dir>` to target an explicit parent
directory instead:

```sh
mkdir workspace && cd workspace
ignex create api --root ../ --features auth,openapi
```

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
  `openapi`, `files`, `ws`, `sse`, `cache`, `proxy`, `cluster`, `templates`,
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
ignex ops compose             docker-compose.yml (Percona MongoDB) + .env.docker
ignex ops caddy               Caddyfile (optimized reverse proxy)
ignex ops docker              all of the above (interactive)
```

The compose target prompts for the MongoDB username/password and writes them to
`.env.docker` (loaded via `env_file`), so secrets never land in the committed
compose file. Pass flags to run non-interactively:

```sh
ignex ops docker --db-user admin --db-password "$DB_PASS" --replica --domain api.example.com
ignex ops docker --yes --db-password "$DB_PASS"   # skip prompts entirely
```

Highlights:

- **Dockerfile** — `oven/bun` builder runs `bun run build --compile --binary-outfile
  <binary>`; a slim `debian:stable-slim` image runs the standalone binary as a
  non-root user with a `wget` healthcheck on `GET /health`. `--private-registry`
  opts into copying `.npmrc`/`.env` for private installs.
- **compose** — `app` (builds the Dockerfile) + `percona/percona-server-mongodb`
  with `--replica` adding a single-node replica set (`rs0`) and a one-shot
  `mongodb-init` service that calls `rs.initiate()`. The app connects via
  `MONGODB_URI` (override with `--mongo-uri-var`).
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
