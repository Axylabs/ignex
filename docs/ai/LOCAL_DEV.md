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
| `castrum` | `castrum` (Rust addon `castrum.<platform>-<arch>.node`) | `castrum` |
| `ignex-mongodb` | `@ignex/ninox` | `@ignex/ninox` |
| `ignex-nova` | `@ignex/nova` | `@ignex/nova` |

This is the supported Bun ≥ 1.4 (Rust-based runtime) local-development
mechanism ([`bun link` docs](https://bun.com/docs/cli/link),
[bun.com/blog/bun-v1.4](https://bun.com/blog/bun-v1.4)) — **maintainers and
AI agents only**. CI and releases always resolve from the registry.

## Known cross-repo edges (verify with `grep` in `package.json` before assuming)

- `@ignex/native` depends on `castrum` (`optionalDependencies: ^0.9.5`).
  Working on both repos? Build the addon files the loader looks for, register the
  package, then link it (the loader needs a package-shaped checkout — a bare
  `target/release/libcastrum.so` is not enough):
  ```bash
  cd /home/adeel/poc/castrum
  cp target/release/libcastrum.so castrum.linux-x64-gnu.node   # baseline
  bash scripts/build-v3.sh                                     # x86-64-v3 SIMD variant
  bun link                                                     # register castrum

  cd /home/adeel/poc/ignex
  bun link castrum                       # root node_modules/castrum → checkout
  ln -s /home/adeel/poc/castrum packages/native/node_modules/castrum
  ```
  `bun link castrum` *inside* `packages/native` fails (`@ignex/test-utils@workspace:*`
  does not resolve outside the workspace root), so that one symlink is created
  directly — it is the same link state bun would produce, and it is the path
  `@ignex/native`'s loader resolves first.

  **Verify the link, don't assume it:** a forgotten `IGNEX_NATIVE_PATH` export
  from an earlier session silently wins over the link (it is the loader's first
  resolution step), which reads exactly like "the link did not work":
  ```bash
  echo "IGNEX_NATIVE_PATH=${IGNEX_NATIVE_PATH:-<unset>}"
  bun -e 'import {getAddonPath,isNativeAvailable} from "./packages/native/src/loader.ts";
          import {nativeQueryDecodeMatchesJs} from "./packages/native/src/decode-compat.ts";
          console.log(getAddonPath(), isNativeAvailable(), nativeQueryDecodeMatchesJs())'
  ```
  With the link live and the v3 binary present, the loader prefers
  `castrum.<platform>-<arch>-v3-<libc>.node` on CPUs with AVX2/BMI2/FMA/SSE4.2
  (`supportsX8664V3()`), so `bun run build:v3` is worth running when tuning
  performance. Then re-run the native gates: `verify:native:ffi`,
  `verify:native:route`, `smoke` and `bench:server:check`.
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
with a clean install; `scripts/release.ts` + `.release.json` handle releases). Keep
`bun link` strictly local.
