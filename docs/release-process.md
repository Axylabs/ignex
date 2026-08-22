# Release Process

Ignex uses a source-only, Bun-first monorepo. This document is the checklist for
cutting a release. Every package is versioned independently
(`packages/*/package.json`) with a shared root version bump as a convenience.

## Pre-release checklist

1. **Bump the compiler cache version** if any generated-code path changed:
   - `COMPILER_CACHE_VERSION` in `packages/compiler/src/cache.ts`.
   - `MODULES_CACHE_VERSION` in `packages/compiler/src/frontend/persist.ts` if the
     persisted per-module parse-cache shape changed.
   - A stale version silently invalidates (safe) — a missed bump can serve
     stale cached builds.
2. **Run the full gate**:

   ```sh
   bun run verify         # typecheck + lint + tests + jsdoc:check:strict
   bun run verify:all     # adds the mongo + nova gates (typecheck/test/verify:nova)
   bun run test:coverage
   bun run build
   bun run smoke
   bun run smoke:fallback
   ```

   All must be green. `verify` now includes `jsdoc:check:strict` — every
   public export must carry JSDoc (see [adding-a-feature.md §G](adding-a-feature.md)).
   Coverage thresholds are enforced in CI.

## Publishing the external standalone packages

`@ignex/nova` and `@ignex/ninox` are published from their **own repos**
(`ignex-nova`, `ignex-mongodb`), not from this monorepo:

- **Nova** — source-published (`files: index.ts public src rust prebuilds docs`);
  keep the `events`/`bindings`/`generate` subpaths stable (the notifier + CLI
  template import `@ignex/nova/events`). The Rust addon must be built and
  staged into `prebuilds/<platform>-<arch>/` for the FFI-backed encode paths.
- **Ninox** — ships `dist/` (tsup); keep the `@ignex/ninox` name and the
  `check:api` gate (API.md ↔ barrel). Run `bun run prepublishOnly` from
  `ignex-mongodb`.

This monorepo consumes them through registry semver ranges; the root
`overrides` block points them at local `file:` links for development. When a
new version is published, update the semver ranges here (and drop or refresh
the `file:` overrides as needed).
3. **Regenerate stale artifacts** (if they are committed):
   - `repomix-output.txt` — `bunx repomix` (AI context dump; gitignored now).
   - `project.txt` / package `project.txt` — `python3 context.py`.
4. **Update the READMEs**:
   - Root `README.md` (status / roadmap / workflow sections).
   - Per-package READMEs if public APIs changed.
   - `docs/` if the architecture or extension points changed.
5. **Version bump**: update `version` in the root and each changed package
   (`packages/*/package.json`). Keep semver:
   - `0.x` — breaking changes are allowed between minors while pre-1.0.

## Tag & publish

Publish order (dependency order): `@ignex/shared` → `@ignex/native` →
`@ignex/core` → `@ignex/compiler` → `@ignex/cli` → `@ignex/mcp`.

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
- CI has no npm publish job by design; releases are manual via
  `scripts/publish.ts` (`bun run release:dry` / `release:bump` / `release`). If
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
