# Compatibility matrix — ignex ↔ standalone projects

ignex is a framework monorepo that consumes three **external standalone
projects** (each with its own git repo, CI and release cycle). They are never
copied into this monorepo; ignex resolves them through **registry semver ranges**
and, for local development, through `bun link` (see `docs/ai/LOCAL_DEV.md`).

## Declared dependencies (the publish contract)

| Package | Declared by | Range | Sibling checkout (`/home/adeel/poc/`) | Role in ignex |
|---|---|---|---|---|
| `@ignex/nova` | root devDeps; `packages/core` peer (optional) | `^0.1.7` / `^0.1.1` | `nova` (0.1.7) | typed realtime transport (FlatBuffer pub/sub, Rust FFI, NATS) |
| `@ignex/ninox` | `packages/app` | `^0.1.3` | `ninox` (0.1.6) | schema-first MongoDB toolkit |
| `castrum` | `packages/native` `optionalDependencies` | `^0.9.10` | `castrum` (0.9.10) | Rust addon consumed only through `@ignex/native` |

The ignex version lives in the root `package.json` (and `CHANGELOG.md`);
`@ignex/nova` and `@ignex/ninox` are the only external packages linked into
this repo during development.

## Consumption model

- Manifests declare **registry semver ranges** — that is the publish contract.
  `@ignex/native` never imports `castrum` directly; the loader `require()`s it
  and every primitive ships a byte-compatible pure-TS fallback.
- **Local development uses `bun link`, not `file:`/`overrides`.** The root
  `package.json` has no `overrides` block and the root `tsconfig.json` has no
  `@ignex/nova` paths: both were removed. To test a local castrum/nova/ninox,
  follow `docs/ai/LOCAL_DEV.md`.
- `@ignex/nova` is an **optional peer** of `@ignex/core`: `novaPlugin` and the
  notifier lazy-import it (`@ignex/nova/server`, `@ignex/nova/events`) and
  degrade gracefully when it is absent.

## API surface ignex relies on

**`@ignex/ninox`** (app + CLI templates + debugbar integration):

- `createMongoToolkit`, `defineCollection(s)`, `s` schema DSL, `InferDoc`,
  `InsertInput`, `UpdateInput`
- `./utils` subpath
- `service.db` manager surface: CRUD, pagination (`paginateFlexible`,
  `paginateCursor`), aggregation, populate, hooks, migrations
- `traceDbOp` (internal, not part of the public barrel): the optional
  ignex-debugbar hook — probed lazily, zero-cost pass-through when
  `@ignex/core` is absent

**`@ignex/nova`** (core plugins + CLI templates + verify script):

- subpath exports: `./server`, `./client`, `./nats`, `./events`,
  `./bindings`, `./generate`, `./internal`
- `createServer` (Bun-only, Rust FFI), `createClient` (browser + Bun),
  `emitToUser` / `on` (events facade), `generateBindings` (generic codegen)

**`castrum`** (via `@ignex/native` wrapper): the NAPI addon's C-ABI surface
that `packages/native` binds to — verified by `bun run verify:native:ffi`
(74 parity checks) and `bun run test:native`. The hand-maintained type stub
is `packages/native/src/vendor/castrum.d.ts`; it covers the surface ignex
uses, not the full generated `index.d.ts` from the castrum repo.

## Version alignment rules

1. Bumping ninox/nova/castrum happens **in their own repos**; ignex only
   widens/narrows its semver ranges afterwards.
2. Strictness parity: all three repos enable `exactOptionalPropertyTypes`
   (and the same `strict` baseline), so source moved between repos keeps
   type-checking.
3. The debugbar integration: ninox's `traceDbOp` lazily imports
   `@ignex/core/debug` and records `db` spans. Its integration test lives in
   this repo (`packages/core/test/trace-db-op.integration.test.ts`) and imports
   ninox's source from the standalone repo, so the coupling is exercised
   without shipping ignex inside ninox.

## Keeping them in sync

When code changes flow between this repo and a standalone repo (either
direction), the reconciliation procedure used for the 2026-08-22
de-consolidation is the reference:

1. Snapshot the "base" (the state the copy was made from) via
   `git archive <adoption-commit> -- <package>`.
2. Format-normalize base / monorepo copy / standalone tree with the target
   repo's biome config, then classify each file:
   `SAME` (no-op) / `STANDALONE-ONLY` (keep theirs) / `MONO-ONLY` (take ours)
   / `MERGE` (three-way) / `NEW-*` / `ONLY-*`.
3. Apply semantic deltas only — ignore pure formatting/reordering churn and
   unused lint suppressions; regenerate build artifacts (generated code,
   `dist/`) rather than syncing them.
4. Verify with each repo's own gates: typecheck, lint, tests, API-surface
   checks, CI.

See `docs/architecture.md` (external-package model) and
`docs/release-process.md` (publishing from the standalone repos) for details.
