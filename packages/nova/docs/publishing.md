# Publishing ignex-nova to npm

ignex-nova is published **from source** — the tarball contains TypeScript
entrypoints (Bun runs `.ts` natively, so consumers need no build step), the
generated artifacts, the `rust/` source, and prebuilt native addons. This
mirrors how the `@ignex/*` packages in the Ignex monorepo are shipped.

## Package layout (`package.json`)

| Field | Value | Why |
| --- | --- | --- |
| `main` / `module` / `types` | `./index.ts` | source entrypoint (Bun-native) |
| `exports` | `.` → `index.ts`, `./server` → `public/server.ts`, `./client` → `public/client.ts`, `./nats` → `public/nats.ts`, `./package.json` | typed subpath API |
| `files` | `index.ts`, `public`, `src`, `rust`, `prebuilds`, `docs`, `README.md`, `LICENSE` | everything consumers need, nothing they don't |
| `publishConfig` | `{ "access": "public" }` | unscoped package must be public |
| `engines` | `{ "bun": ">=1.4" }` | Bun-only runtime |
| `sideEffects` | `false` | safe to tree-shake / mark in bundlers |

`rust/.npmignore` keeps `rust/target/` (build output), `Cargo.lock` and the
dev example out of the tarball while still shipping the Rust **source** so
consumers can rebuild the addon on any platform.

## The release pipeline

```
bun run release            ──►  bump version
                                  │
                                  ├─► verify     (typecheck + lint + test)
                                  ├─► pack:check (tarball contents gate)
                                  ├─► bun publish
                                  │      ├─ prepublishOnly  → generate + verify
                                  │      └─ prepack         → prebuild (stage addon)
                                  └─► git commit + tag vX.Y.Z (+ push)
```

### 1. Version bump
`scripts/release.ts` supports `patch | minor | major` (default `patch`) or an
explicit `--version`. Prereleases finalize on the next bump
(`0.2.0-beta.1` → `0.2.0`).

### 2. Verify gate
`bun run verify` = `typecheck` + `lint` + `test`. `prepublishOnly` first runs
`generate` so the TypeBox → `.fbs` → flatc → glue artifacts are always fresh
in the tarball (they're gitignored, so they must be regenerated at publish).

### 3. Tarball check
`bun run pack:check` runs `bun pm pack --dry-run --json` and asserts:

- required files present: entrypoints, `src/`, `rust/Cargo.toml`, docs, README, LICENSE
- nothing heavy/private leaks: `rust/target/`, `dist/`, `node_modules/`, `client-dist/`, tests, benches

### 4. Native addon staging
`prepack` runs `bun run prebuild` → `scripts/build-prebuild.ts`:

```
cargo build --release  →  rust/target/release/libignex_ffi.{so,dylib,dll}
    cp →  prebuilds/<platform>-<arch>/libignex_ffi.{so,dylib,dll}
```

The loader (`src/native/loader.ts`) resolves the addon in this order:

1. `IGNEX_FFI_PATH` env override
2. in-repo dev build: `<repo>/rust/target/release/<lib>`
3. packaged layout: `<pkg>/prebuilds/<platform>-<arch>/<lib>`

So consumers on a platform with a shipped prebuild need **zero setup**; others
rebuild from the shipped `rust/` source or set `IGNEX_FFI_PATH`.

### 5. Publish
`bun publish` (equivalent to `npm publish`) with `--tag <dist-tag>`
(default `latest`) and `--access public`.

## Releasing

### Manual (from a checkout)

```bash
bun run release:dry                # plan only
bun run release                    # patch bump → publish → commit + tag + push
bun run release minor --tag beta   # minor + dist-tag `beta`
bun run release --version 0.2.0 --no-verify --no-check
bun run release --no-commit        # bump + publish, no git side effects
bun run release --no-bump --no-verify --no-commit   # retry publish as-is
```

First release from a fresh checkout needs the generated artifacts + a built
addon — `release` handles both via `prepublishOnly`/`prepack`, but you need a
local Rust toolchain + `flatc` (see README "Prerequisites").

### CI (`.github/workflows/publish.yml`)

Triggered by a `v*` tag push or `workflow_dispatch` (with optional `version`
and `dist_tag` inputs). It builds prebuilds for **ubuntu-latest**
(linux-x64), **macos-latest** (darwin-arm64) and **macos-13** (darwin-x64),
merges them into `prebuilds/`, sets the version from the tag/input, runs the
full gate, then publishes.

Set the `NPM_TOKEN` repo secret (an npm access token with publish rights) for
the publish step. Provenance/attestations can be enabled by using
`npm publish --provenance` and an `id-token: write` permission (the workflow
already grants it).

## Pre-publish checklist

- [ ] `bun run verify` passes locally
- [ ] `bun run pack:check` shows the expected files and no `rust/target/`
- [ ] `prebuilds/` contains the addon(s) you intend to ship
- [ ] npm auth works: `npm whoami`, and `NPM_TOKEN` is set for CI publishes
- [ ] version is correct (`bun run release --version X.Y.Z`)

## Tarball hygiene notes

- `files` is an allowlist — only the listed top-level entries are packed.
- Nested `rust/.npmignore` excludes `rust/target/` (platform-specific build
  output, GB-scale) and `Cargo.lock` (library crates don't commit it).
- `prebuilds/` is empty (or absent) until `prepack`/CI stages addons, so a
  source-only tarball is fine too — the loader just falls back to rebuild/`IGNEX_FFI_PATH`.
- The gitignored `src/generated/` artifacts ARE packed (they're under the
  included `src/`) — that's intentional: consumers must not need `flatc`.
