# Local Development with the Core Projects — `bun link`

> **Scope**: maintainers and AI agents working across the IgnEX core stack.
> Application developers consume published versions from npm and do **not**
> need this file.

## Why

This repo (`ignus`) **is** a core project: the `ignex` monorepo whose
`packages/*` (`@ignex/core`, `@ignex/cli`, `@ignex/compiler`, `@ignex/native`,
`@ignex/shared`, `@ignex/mcp`, `@ignex/app`, `@ignex/test-utils`,
`create-ignex`) ship as the IgnEX framework. The other core packages live
side-by-side, one directory back in `/home/adeel/poc/`:

| Repo (`/home/adeel/poc/`) | Package(s) | `bun link` name |
| --- | --- | --- |
| `ignus` — this monorepo | `@ignex/core`, `@ignex/cli`, `@ignex/compiler`, `@ignex/native`, `@ignex/shared`, `@ignex/mcp`, `@ignex/app`, `@ignex/test-utils`, `create-ignex` | run `bun link` inside each package dir |
| `bun-rust-runtime-bench` | `castrum` (Rust addon `castrum.<platform>-<arch>.node`) | `castrum` |
| `ignex-mongodb` | `@ignex/ninox` | `@ignex/ninox` |
| `ignex-nova` | `@ignex/nova` | `@ignex/nova` |

This is the supported Bun ≥ 1.4 (Rust-based runtime) local-development
mechanism ([`bun link` docs](https://bun.com/docs/cli/link),
[bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4)) — **maintainers and
AI agents only**. CI and releases always resolve from the registry.

## Known cross-repo edges (verify with `grep` in `package.json` before assuming)

- `@ignex/native` depends on `castrum` (`optionalDependencies: ^0.9.1`).
  Working on both repos? Link `castrum` into `packages/native`:
  ```bash
  cd /home/adeel/poc/bun-rust-runtime-bench
  bun link                                    # register castrum
  cd /home/adeel/poc/ignus/packages/native
  bun link castrum                            # symlink node_modules/castrum → ../../
  ```
- `@ignex/core` has `@ignex/nova` as an **optional peer** (peerDependenciesMeta).
  To test a local nova: `cd /home/adeel/poc/ignex-nova && bun link`, then
  `cd /home/adeel/poc/ignus/packages/core && bun link @ignex/nova`.
- Consumers of this repo (e.g. `ignex-app` using `@ignex/core`, `@ignex/cli`,
  `@ignex/ninox`): link each needed package:
  ```bash
  cd /home/adeel/poc/ignus/packages/core && bun link     # @ignex/core
  cd /home/adeel/poc/ignus/packages/cli  && bun link     # @ignex/cli
  cd /home/adeel/poc/ignex-app && bun link @ignex/core @ignex/cli
  ```

## How to link (mechanics)

```bash
# 1. Register the package (once per machine, from the package dir):
cd /home/adeel/poc/ignus/packages/core
bun link            # → Success! Registered "@ignex/core"

# 2. Link it into the consumer project:
cd /home/adeel/poc/ignex-app
bun link @ignex/core              # symlinks node_modules/@ignex/core → ../ignus/packages/core
bun link @ignex/core --save       # also writes "link:@ignex/core" into package.json deps
```

- `bun link` (no args) registers the current package globally for this user.
- `bun link <name>` creates a symlink in the consumer's `node_modules`;
  `--save` additionally records `"<name>": "link:<name>"` in `package.json`.
- Unregister: `bun unlink` from the package dir. Return to registry versions:
  remove the `link:` entry and `bun install`.

## Rust-core caveats

- `castrum` (and `@ignex/nova`) ship Rust cdylibs. After changing Rust source,
  rebuild the addon BEFORE linking/using:
  - castrum: `bun run build` (release `napi build`) or `bun run build:debug`.
  - `@ignex/nova`: `bun run build:rust`
    (`cargo build --release --manifest-path rust/Cargo.toml`).
- A stale `.node`/`.so` silently serves old behavior — rebuild, then re-test.
- `@ignex/native` treats native as a pure acceleration layer: `IGNEX_NATIVE=off`
  forces pure-TS fallbacks (the monorepo's `smoke:fallback` runs this way).
  `docs/native-acceleration.md` documents the `IGNEX_NATIVE_PATH` override.

## Never publish from a linked tree

Publishing a consumer whose dependencies are `link:` entries ships symlinks,
not packages. Releases always run against registry versions (CI re-verifies
with a clean install; `scripts/publish.ts` handles monorepo releases). Keep
`bun link` strictly local.
