# Release Process

Ignex uses a source-only, Bun-first monorepo. This document is the checklist for
cutting a release. Each `packages/*/package.json` carries its own version, and a
release bumps the root plus **only the packages that changed** (plus their
dependents). The root `package.json` `version` is the workspace/release version
that `scripts/release.ts` also writes into the tracked version files declared in
`.release.json` `versionFiles` — never hard-code a version in prose.

> **Shared canonical flow.** All four product repos — `ignex`, `castrum`,
> `@ignex/ninox` and `@ignex/nova` — release through ONE flow: the canonical
> `scripts/release.ts` driven by a per-repo `.release.json`. This repo is the
> canonical home of the script; the sibling repos carry identical copies (castrum
> reformats its copy to its single-quote Biome style) configured by their own
> `.release.json` (verify commands, version files like `Cargo.toml`/`CHANGELOG`,
> the npm publish strategy: `local` vs `ci`/tag-push, and the optional
> `selectChanged` changed-package selection). When syncing the updated script to
> a sibling repo, copy `scripts/release.ts` (and the new `.release.json` keys)
> from here.

## Pre-release checklist

1. **Bump the compiler cache version** if any generated-code path changed:
   - `COMPILER_CACHE_VERSION` in `packages/compiler/src/cache.ts`.
   - `MODULES_CACHE_VERSION` in `packages/compiler/src/frontend/persist.ts` if the
     persisted per-module parse-cache shape changed.
   - A stale version silently invalidates (safe) — a missed bump can serve
     stale cached builds.
2. **Run the full gate**:

   ```sh
   bun run verify         # typecheck (root+cli) + lint + tests + jsdoc:check:strict + check:dead
   bun run verify:all     # + the nova plugin gate (verify + verify:nova)
   bun run test:coverage
   bun run build
   bun run smoke
   bun run smoke:fallback
   ```

   All must be green. `verify` now includes `jsdoc:check:strict` — every
   public export must carry JSDoc (see [adding-a-feature.md §H](adding-a-feature.md)).
   Coverage thresholds are enforced in CI.

3. **Regenerate stale artifacts** (if they are committed):
   - `repomix-output.txt` — `bunx repomix` (AI context dump; gitignored).
4. **Update the READMEs**:
   - Root `README.md` (status / roadmap / contributing sections).
   - Per-package READMEs if public APIs changed.
   - `docs/` if the architecture or extension points changed.
5. **Version bump**: update `version` in the root and each changed package
   (`packages/*/package.json`). Keep semver:
   - `0.x` — breaking changes are allowed between minors while pre-1.0.

## Which packages get released

Workspace releases publish **only the packages that changed since the last
release tag, plus anything that (transitively) depends on them** — unchanged
packages keep their current version and are **not** re-published. The base for
the comparison is the most recent `v*` release tag reachable from `HEAD`
(`git tag --merged HEAD`), so the very first release publishes everything.

Opt in with `"selectChanged": true` in `.release.json` (this repo does) or pass
`--changed` for a one-off run. Selection precedence:

- `--packages <name>` — manual subset + dependents (unchanged behavior).
- `--all` — release **every** workspace package (old behavior; overrides
  `selectChanged` and is useful for a forced full release).
- `--changed` — force changed-package selection when the config has not opted in.
- otherwise, with `selectChanged`, only the changed packages + dependents.

If nothing has changed since the last tag the release aborts with a hint
(re-run with `--all` for a full release, or `--packages <name>` for a manual
subset). `bun run release:dry` prints the exact planned package set before
anything is bumped or published.

Example: after tag `v0.2.0`, if only `@ignex/cli` and `@ignex/compiler`
changed, `bun run release` bumps and publishes `@ignex/compiler`, `@ignex/cli`
and their dependents (`@ignex/mcp`, `create-ignex`) — not the whole workspace.

## Versioning, support & deprecation

Packages under `packages/*` version **independently**, so a tag legitimately
carries a different version per package (a patch to the CLI does not move
`@ignex/native`). There is therefore **no single "ignex version" to pin**: the
workspace root version is the release-train marker, and dependants declare
semver ranges. To see exactly what a checkout carries — without hard-coding
version literals into docs, which `RULES.md` §6 forbids — run:

```sh
bun run release:matrix          # Markdown table: package → version → published?
bun run release:matrix --json   # the same data, machine-readable
```

What that means for a consumer:

- **Pin ranges, not versions** (`"@ignex/core": "^<current minor>"`). The frozen
  `exports` subpath map is the real compatibility contract —
  `bun run check:consistency` freezes it against `scripts/api-surface.json` — so
  a minor bump cannot silently drop a subpath you import.
- The `@ignex/*` packages in one train are mutually compatible: each manifest's
  `workspace:*` dependency is published as the concrete range of the version
  released alongside it.
- The generated app SDK is versioned separately — see
  [App SDK releases](#app-sdk-releases).

### Deprecation policy

While pre-1.0, semver's own rule applies: **a breaking change may ship in a
minor**, and `CHANGELOG.md` records every one. To keep that survivable:

1. A deprecation is announced under `Deprecated` in `CHANGELOG.md` **one minor
   before** the removal, naming the replacement.
2. The deprecated export keeps working for that minor (a runtime warning is
   preferred over removal) and is removed in the next minor — never in a patch.
3. **Patches never break behaviour.** A patch fixes; a minor may break, with the
   notice above.

### Support window

| Release | Security fixes | Notes |
| --- | --- | --- |
| Current minor | Yes | the only supported line (see [SECURITY.md](../SECURITY.md)) |
| Older minors | No | upgrade to the current minor |
| LTS, post-1.0 | Planned | latest major + previous major, 12 months each |

There is **no backport branch today** and no LTS line yet. When 1.0 ships this
table becomes the contract, and a `release/<major.minor>` branch is cut per
supported line at that point. Until then, run the current minor.

## Publishing the external standalone packages

`@ignex/nova` and `@ignex/ninox` are published from their **own repos**
(`nova`, `ninox`), not from this monorepo:

- **Nova** — source-published (`files: index.ts public src rust prebuilds docs`);
  keep the `events`/`bindings`/`generate` subpaths stable (the notifier + CLI
  template import `@ignex/nova/events`). The Rust addon must be built and
  staged into `prebuilds/<platform>-<arch>/` for the FFI-backed encode paths.
- **Ninox** — ships `dist/` (tsup); keep the `@ignex/ninox` name and the
  `check:api` gate (API.md ↔ barrel). Run `bun run prepublishOnly` from
  `ninox`.

This monorepo consumes them through registry semver ranges; the root
`overrides` block points them at local `file:` links for development. When a
new version is published, update the semver ranges here (and drop or refresh
the `file:` overrides as needed).

## Tag & publish

The publish order below (dependency order) applies to whatever set the release
selected — by default only changed packages + dependents (see above).

```sh
# 1. Commit with a conventional message
git add -A
git commit -m "release(ignex): v0.2.0"

# 2. Tag
git tag v0.2.0
git push --tags

# 3. Publish packages (in dependency order)
npm publish --workspace packages/shared
npm publish --workspace packages/native
npm publish --workspace packages/core
npm publish --workspace packages/compiler
npm publish --workspace packages/cli
```

> The CLI is source-only (`bin/ignex.js` imports `../src/index.ts`), so the
> published tarball must include `src` — it does via `files: ["bin", "src"]`.

## npm authentication (no committed tokens)

- **Prefer env-based auth.** For local publishes, export `NODE_AUTH_TOKEN`
  (or configure `~/.npmrc` in your user profile) instead of a repo `.npmrc`.
- **Never commit a token.** A hardcoded `//registry.npmjs.org/:_authToken=...`
  in the repo `.npmrc` is a live credential — if one is present, rotate it at
  https://www.npmjs.com/settings/<user>/tokens and delete the line (the file is
  gitignored, but a leaked token is a leak regardless).
- **"does not exist in this registry" means bad credentials, not a missing
  package.** npm answers an unauthorized *write* with `404 Not Found`, so an
  expired or revoked token makes the publisher print
  `404 Not Found: https://registry.npmjs.org/@ignex%2fnative` followed by
  `'@ignex/native@0.2.0' does not exist in this registry` — while the very same
  package reads back fine from the registry. Classic `_authToken`s that bypass
  2FA are being retired for direct publishing, so re-authenticate with
  `npm login` (or a granular read/write token) instead of minting another
  classic one. `scripts/release.ts` runs `npm whoami` in its preflight and stops
  before the bump when the credential is dead.
- CI has no npm publish job by design; releases are manual via the shared
  canonical flow `scripts/release.ts` + `.release.json` (`bun run release:dry` /
  `release:bump` (`--no-publish`) / `release`). If
  a CI publish job is ever added, wire the token via a GitHub secret +
  `NODE_AUTH_TOKEN` (never a file).

## Post-release

- Update `packages/app` and the CLI's scaffolded `@ignex/*` dependency versions.
- Bump the `castrum` addon version in `packages/native` if the Rust surface
  changed (keep `Cargo.toml` ↔ `package.json` in sync).
- Verify a fresh `bun install` from the tarballs in a clean project
  (`bunx ignex create my-app`).

## App SDK releases

The app's typed SDK (see [sdk.md](sdk.md)) is versioned independently of the
framework packages and released on its own cadence:

```sh
bun run sdk:push       # build + generate + git tag sdk-v<version> + push
bun run sdk:publish    # + npm publish (private registry via SDK_NPM_REGISTRY / --registry)
bun run sdk:release    # + GitHub release with the packed .tgz for direct download
```

Keep the SDK version aligned with the API version the client targets so
frontend teams can pin SDK ↔ API versions 1:1. Use `bun run sdk --dry-run`
first to preview the plan.

## Security

Follow [SECURITY.md](../SECURITY.md): report privately, patch, then release and
disclose.
