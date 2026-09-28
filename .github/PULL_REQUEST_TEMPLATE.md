<!--
Keep this short. The "why" matters more than the diff; the gates below are the
changed-behaviour contract. Delete any section that does not apply.
-->

## What this changes

<!-- One or two sentences. Link the issue (`Closes #123`) when there is one. -->

## Why

<!-- The problem, and why this approach over the alternatives. -->

## How it was verified

<!-- The commands you actually ran, and anything a reviewer must reproduce. -->

- [ ] `bun run verify:quick` (typecheck + lint + JSDoc + maintainability + consistency)
- [ ] `bun run test:parallel`
- [ ] AOT/compile changes: `bun run build && bun run smoke` and `bun run smoke:fallback`
- [ ] Native changes: `bun run verify:native:ffi` and `bun run verify:native:route`

## Checklist

- [ ] Docs match the code — `AGENTS.md`/`RULES.md`/the relevant `.agents/skills/` runbook and `docs/*.md` updated where behaviour changed
- [ ] `CHANGELOG.md` has an entry under `[Unreleased]` (do not add a release heading)
- [ ] Generated-code changes bumped `COMPILER_CACHE_VERSION` / `MODULES_CACHE_VERSION`
- [ ] Public `exports` changes are deliberate — `bun scripts/check-consistency.ts --update` run and the `scripts/api-surface.json` diff reviewed
- [ ] No credentials or private data in the diff (`bun run scan:secrets`)
