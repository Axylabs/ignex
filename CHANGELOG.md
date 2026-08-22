# Changelog

All notable changes to the ignex monorepo are documented here, grouped by
release. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions adhere to [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Removed

- **`@ignex/nova` and `@ignex/ninox` are no longer workspace packages** —
  `packages/nova` and `packages/mongo` were removed from this monorepo. Both
  projects were synced back to their standalone repos first (strict-typing
  fixes, test gating, the ninox debugbar `traceDbOp` hook, generator
  `@ts-nocheck` emission — see the `sync:` commits in `ignex-nova` /
  `ignex-mongodb`), so no work was lost. ignus now consumes them as external
  packages: registry semver ranges in manifests, with local `file:` overrides
  (root `package.json` → `overrides`) pointing at the standalone repos for
  development. The `mongo`/`nova` CI jobs moved to the standalone repos' own
  workflows; the novaPlugin end-to-end bridge check (`verify:nova`) now runs
  against the external `@ignex/nova` via the `file:` link.

### Added

- **Debugbar: NATS event tracking (Events panel)** — a zero-dependency NATS
  core-protocol client (Bun TCP; INFO/CONNECT/PING/PONG/PUB/SUB/MSG, no npm
  package, JetStream-free) plus a bounded event ring buffer. Auto-enabled by
  `$NATS_URL` or `debugbar({ nats })`: subscribes to subjects (default
  `events.>`), records every outbound publish and inbound message with
  truncated payloads, and exposes `GET /api/events`,
  `POST /api/events/publish` (probe events) and `POST /api/events/clear`.
  Failures become error events; reconnect backs off — a broken server never
  crashes the app.
- **Debugbar: published-clients panel** — the Clients view probes
  `sdkPaths` + `clientPaths` (package.json / sdk.json / directories) and
  combines local package state with git tags (`git for-each-ref`, cached,
  `sdk-v*` prefix): name/version/location/files + **tagged ✓ vs local-only**.
  The KT page and `GET /api/sdks` now include the tag state.
- **Debugbar: AI debugging via MCP** — `@ignex/mcp` gained nine debugger
  tools (`debug-summary`, `debug-requests`, `debug-request`, `debug-replay`,
  `debug-events`, `debug-event-publish`, `debug-system`, `debug-clients`,
  `debug-kt`) driven by `IGNEX_DEBUGBAR_URL`/`IGNEX_DEBUGBAR_TOKEN`, plus a
  token-efficient `GET /api/ai/summary` snapshot (errors, slow traces, event
  stats, clients). The dashboard gained Events / Clients / AI views.
- **SDK: FlatBuffers frontend-client platform** — `ignex sdk --platform
  flatbuffers` emits an installable npm package: a real `schema.fbs` (wire
  envelope + route inventory), a typed per-route client sending
  `application/x-flatbuffers` envelopes on the official `flatbuffers` runtime
  (JSON fallback, GET/HEAD params in the URL), and `kind: "client"` metadata
  so the debugbar tracks it. Registered in `--platform all` for the CLI and
  `scripts/generate-sdk.ts`; publish/push/release flows are shared with the
  other SDK platforms.
- **Debugbar waterfall: automatic lifecycle-stage rows** — every request is
  now traced through the framework, not just the app's explicit `ctx.debug`
  spans: the `request`, `beforeHandle`, `handler`, `afterHandle`,
  `mapResponse`, `afterResponse` and `trace` stages each become waterfall
  rows (recorded in the interpreted pipeline, the router path and the
  compiler-generated server via shared `runTimed`/`debugStageEnd` runtime
  helpers). A request with zero manual instrumentation now shows exactly
  where its time went.
- **Debugbar time breakdown + idle gaps** — the Overview and Waterfall tabs
  show a per-kind breakdown (stacked bar + db/cache/http/render/auth/
  lifecycle/custom rows with ms and % of total, plus **unaccounted** time),
  and the waterfall draws hatched idle-gap segments between spans so
  event-loop waits are visible.
- **Debugbar expandable span rows** — clicking any waterfall bar unfolds the
  span's details (kind, start/duration, attrs such as query text or target
  URL, origin stack frame, error); the span tree shows attrs inline too.
- **Ninox DB ops in the debugbar** — every `@ignex/ninox` (Mongo) operation
  (CRUD, pagination, aggregation) is now recorded as a `db` span in the
  current request's trace when running inside ignex with the debugbar on
  (`traceDbOp` bridges into the ALS-propagated `debugQuery` helper via a
  lazy, cached optional import — zero dependency on `@ignex/core`, so
  standalone ORM usage and production apps pay nothing).
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
- The lifecycle pipeline (interpreted, router and compiled) wraps every stage
  in shared `runTimed`/`debugStageEnd` instrumentation; the flat no-trace hot
  path is unchanged.
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

### Fixed

- Debugbar waterfall no longer shows a bogus "✕ … span left open" on the
  root span of every request (the root is the request itself), and framework
  stage rows are closed without the leak flag when the debugbar finalizes the
  trace inside the afterHandle stage.

## [0.1.7] — 2026-08

Initial open-source milestone: AOT compiler pipeline with persistent parse
caching, Bun-native router codegen, precompiled Ajv validators + serializers,
native acceleration (`@ignex/native` × castrum), CLI, MCP server, durable
jobs, scheduler (croner), debugbar, and the example app. See the git history
for the full breakdown.
