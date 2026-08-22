# Changelog

All notable changes to the ignex monorepo are documented here, grouped by
release. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions adhere to [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Bun-first scheduler** — `createScheduler` now ticks through `Bun.cron`
  (standard 5-field expressions + `@named` schedules, validated by
  `Bun.cron.parse` at registration, zero lockfile deps, built-in
  never-overlap). Legacy croner-style 6-field (second-precision) expressions
  keep working via an in-process matcher (`platform/cron6.ts`). `croner` was
  removed from the dependency tree.
- **Debugbar redesign** — tokenized dark/light themes, server-side KT
  rendering via `Bun.markdown` + an allowlist sanitizer (`debug/markdown.ts`),
  server-side request filters (`q`/`method`/`status`), request-detail tabs,
  gradient system charts, keyboard shortcuts, and a stylesheet served at
  `{path}/app.css`.
- **`@ignex/nova` as a workspace package** (`packages/nova`) — the typed
  FlatBuffer realtime transport (events/bindings/codegen layer, Rust FFI
  serializer, NATS bridge) is now source-published in-repo; `novaPlugin`'s
  runtime resolution is fixed (the tsconfig `paths` stub that shadowed the
  real package — breaking `import("@ignex/nova/server")` under Bun — is
  deleted) and `verify:nova` passes end-to-end.
- **`@ignex/ninox` as a workspace package** (`packages/mongo`) — the
  schema-first MongoDB toolkit (schema DSL → `$jsonSchema`, CRUD/pagination/
  aggregation, DataLoader relations, query cache, migrations) is now
  source-only in-repo and type-checks under the root strict flags.
- **CLI display-width helpers** — `utils/terminal.ts` (`Bun.stringWidth` /
  `Bun.sliceAnsi`-backed padding/truncation) used by `route:list` tables.
- **`verify:all`** root script (verify + mongo/nova gates) and
  **`test:parallel`** / **`verify:quick`** via `bun run --parallel`.
- **CI jobs** for the nova realtime transport (Rust addon build + suite +
  plugin bridge) and the Mongo toolkit (Mongo 7 service + suite + API check).
- Root `CHANGELOG.md` (this file).

### Changed

- `createScheduler`'s tick core is extracted into a shared, testable path;
  `ScheduledJob.stop()`/`running` semantics unchanged.
- Debugbar dashboard split into shell / stylesheet / app modules
  (`debug/dashboard-*.ts`).
- `compiledPathFor` memoizes path→regex compilation on the interpreted
  router's hot path (route paths are a finite registration-time set).
- `docs/bun-internals.md` gained Bun 1.4 rows (Bun.cron, Bun.markdown,
  Bun.stringWidth family, `bun run --parallel`, `Bun.serve` static routes
  decision); `docs/native-acceleration.md` gained the 2026-08-22 wiring
  decisions; `docs/debugbar.md` gained a UI tour.

### Removed

- `croner` dependency (root + `@ignex/core`).
- `packages/core/src/vendor/nova.d.ts` ambient stub + its tsconfig `paths`
  entries.
- `@ignex/nova` / `@ignex/ninox` registry/`file:` deps (now `workspace:*`).

## [0.1.7] — 2026-08

Initial open-source milestone: AOT compiler pipeline with persistent parse
caching, Bun-native router codegen, precompiled Ajv validators + serializers,
native acceleration (`@ignex/native` × castrum), CLI, MCP server, durable
jobs, scheduler (croner), debugbar, and the example app. See the git history
for the full breakdown.
