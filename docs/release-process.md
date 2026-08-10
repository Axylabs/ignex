# Release Process

Flux uses a source-only, Bun-first monorepo. This document is the checklist for
cutting a release. Every package is versioned independently
(`packages/*/package.json`) with a shared root version bump as a convenience.

## Pre-release checklist

1. **Bump the compiler cache version** if any generated-code path changed:
   - `COMPILER_CACHE_VERSION` in `packages/compiler/src/cache.ts`.
   - A stale version silently invalidates (safe) — a missed bump can serve
     stale cached builds.
2. **Run the full gate**:

   ```sh
   bun run verify
   bun run test:coverage
   bun run build
   bun run smoke
   ```

   All must be green. Coverage thresholds are enforced in CI.
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

```sh
# 1. Commit with a conventional message
git add -A
git commit -m "release(flux): v0.2.0"

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

> The CLI is source-only (`bin/flux.js` imports `../src/index.ts`), so the
> published tarball must include `src` — it does via `files: ["bin", "src"]`.

## Post-release

- Update `packages/app` and the CLI's scaffolded `@flux/*` dependency versions.
- Bump the `castrum` addon version in `packages/native` if the Rust surface
  changed (keep `Cargo.toml` ↔ `package.json` in sync).
- Verify a fresh `bun install` from the tarballs in a clean project
  (`bunx flux create my-app`).

## Security

Follow [SECURITY.md](../SECURITY.md): report privately, patch, then release and
disclose.
