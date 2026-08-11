# @flux/cli

Developer CLI for flux: scaffold apps, scaffold routes, watch, and build.

Source-only package — `bin/flux.js` (`#!/usr/bin/env bun`) imports
`../src/index.ts` directly, matching the monorepo's source-only convention
(Bun runs TS natively). There is **no build step** and no `dist/` requirement.

## Commands

```
flux create <app-name> [options]   Scaffold a new flux app (22 feature toggles)
flux dev [root] [options]          Compile + run the dev server (watch)
flux build [root] [options]        AOT-compile an app with diagnostics
flux route <path> [options]        Scaffold a single route (--named, --schema)
flux info [root]                   Dump cwd / runtime / config as JSON
```

Run `flux --help` for the full option reference.

## Dev mode (`flux dev`)

`flux dev` compiles the project, spawns the generated server and watches for
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
- `flux build --watch` forwards `--minify` / `--sourcemap` / `--verbose` to the
  compiler and runs the same watch flow.

## Development

```sh
bun run typecheck      # tsc -p tsconfig.json (types: ["node"])
bun bin/flux.js --help # run from source
bun run test           # vitest
```

The CLI's `tsconfig.json` uses `types: ["node"]` (it can run under Node ≥ 22)
and is therefore **excluded from the root tsconfig**. Root CI typechecks it
separately via `bun run typecheck:cli`.

> Note: the compiler is bundled at the source level — the CLI imports
> `@flux/compiler` (`workspace:*`), which is source-only. On a fresh clone,
> `bun install` resolves the workspace deps; no separate build is needed.
