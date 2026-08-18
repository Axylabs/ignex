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
