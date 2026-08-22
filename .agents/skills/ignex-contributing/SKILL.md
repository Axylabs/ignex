---
name: ignex-contributing
description: Add a feature, route, plugin, or new package to the ignex monorepo — the workflow, the verify gates, and the docs/skills that must stay in sync. Use when starting any new feature or package in this repo.
---

# ignex: Contributing (adding features & packages)

The workflow for any change to the ignex monorepo. `docs/adding-a-feature.md`
is the human walkthrough; `docs/release-process.md` covers releases.

## Before you start

1. Read `AGENTS.md` (this repo's rules + map), `RULES.md` (non-negotiables),
   and the relevant `.agents/skills/` runbook (`ignex-codebase-map` first).
2. Don't reinvent: check `@ignex/shared`, `@ignex/core`, `@ignex/native`, and
   the sibling core repos one directory back (`/home/adeel/poc/` — castrum,
   `@ignex/ninox`, `@ignex/nova`) for an existing implementation.

## Where the change goes

| Change | Package | Notes |
| --- | --- | --- |
| Runtime primitive / plugin / route DSL | `packages/core` | domain folder + barrel export; subpaths via `package.json` exports |
| Native op / route-wire | `packages/native` | `SELECTION` row + `*Fallback` twin + parity gates |
| Compiler phase / codegen | `packages/compiler` | bump `COMPILER_CACHE_VERSION` on generated-code shape changes |
| CLI command / scaffold | `packages/cli` | `commands/` + `templates/` |
| SDK / OpenAPI | `scripts/generate-sdk.ts` + `packages/core/src/openapi.ts` | regenerate, never hand-edit SDK output |
| New package | `bun scripts/new-package.ts` | workspaces `packages/*`; add to `test:parallel` if it has tests |
| Shared FP / AOT contract | `packages/shared` | `ContextUsage` touches compiler AND runtime |

## The loop

1. **Code** — small pure functions in small files; factories over explicit
   state (no classes on public surfaces); Bun-first, native via `@ignex/native`.
2. **Tests** — vitest suites under `packages/*/test` (not `bun test`):
   `bunx vitest run packages/<name>/test`. Pure functions get direct unit
   tests; native gets parity tests; the app gets smoke coverage.
3. **Verify** — `bun run verify:quick` (typecheck + typecheck:cli + lint +
   jsdoc:check:strict), then `bun run test:parallel`; native changes add
   `verify:native:route` / `verify:native:ffi` / `test:native:real`; app/compiler
   changes add `bun run smoke` + `smoke:fallback`.
4. **Bench** — hot paths: `bun run bench:*` before/after; never assume.
5. **Docs** — update `docs/*.md` if behavior changed, keep
   `AGENTS.md`/`RULES.md`/relevant `SKILL.md` in sync, regenerate the scaffold:
   `bun run gen:ai-map`. Keep `CHANGELOG.md` current (package.json is 0.1.7).
6. **Scan** — `bun run scan:secrets` before pushing.

## Do NOT

- Import castrum directly outside `packages/native`.
- Make native a hard dependency or break `IGNEX_NATIVE=off` parity.
- Mutate the `SELECTION` table at runtime.
- Hand-edit generated artifacts (compiler output, `packages/app/dist`, SDK).
- Introduce classes into public surfaces where the pattern is composition.
- Forget the doc/skill sync — stale docs are a merge-blocking smell here.
