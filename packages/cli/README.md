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
