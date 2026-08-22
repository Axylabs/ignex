# Changelog

All notable changes to `ninox` are documented here. The format is
based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed

- **Internal refactor — no API changes.** Source tree reorganized for
  maintainability: the biggest files were split into same-named folders with
  barrel re-exports (`crud/`, `hot-cache/`, `validate-doc/`, `pagination/`,
  `aggregation/`, `errors/`, `migrations/`); the service composition root
  (`service/index.ts`) was slimmed into `config.ts` / `manager.ts` / `health.ts`;
  connection helpers moved under `service/`; `utils/cache.ts` renamed to
  `utils/memoize.ts`; and a shared `op-deps.ts` now dedupes the `{ trace, meta }`
  boilerplate across op factories. All 216 barrel exports, types, and the dist
  output are unchanged. `TRANSIENT_MONGO_ERROR_CODES` is now a frozen
  `ReadonlySet`. Added `scripts/check-api.ts` (`bun run check:api`) to keep the
  barrel and `API.md` in sync.

## [0.1.0] — 2026-08-16

### Added

- **Schema-first typed DSL → MongoDB `$jsonSchema`** — strict by default
  (`additionalProperties: false`), ORM lifecycle fields reserved (`_id`, `__v`,
  `deletedAt`), `createSchema` / `updateSchema` / `syncIndexes`, read-side drift
  detection (`off` / `report` / `throw`), and an `s.jsonSchema` raw escape hatch
  for anything the DSL doesn't model.
- **CRUD + performance by default** — read-through `QueryCache` with
  per-collection write-through invalidation, in-flight dedup, `stats()`;
  `cacheWatch: true` opts into change-stream invalidation for external writers
  (replica sets).
- **Hot cache (`createHotCache`)** — global read-through LRU with replica
  change-stream or standalone-ticker freshness, manual invalidation, `stats()`,
  `maxValueBytes`, and `mode` pinning.
- Typed aggregation pipeline builder (`db.pipeline()`), keyset/cursor
  pagination, geo (`s.geoPoint` / `$geoNear`), auto-timestamps, repository
  layer, health checks, text search, graceful transactions with fallback,
  file-based migrations, DataLoader-batched relations.
- Error taxonomy (`DomainError` / `InfraError`) with HTTP status mapping,
  `serializeError`, and `wrapMongoErrors` on by default.

### Fixed

- **HotCache write-after-invalidate race** — a generation guard prevents an
  in-flight load from re-storing stale data after an invalidation.
- **Multi-DB cache/dedup collision** — cache and in-flight-dedup keys are
  namespaced by database, so same-named collections in different databases can
  never share (or coalesce) entries.
- `_id` declared-type mismatch between `InferDoc` and the DB validator (a
  user-declared `_id` is now respected).
- Failed DataLoader batches are no longer cached (a later load retries).
- Mixed/null enum `bsonType` unions; the unsupported `format` keyword is no
  longer emitted into `$jsonSchema`.

### Changed

- **Public surface cleanup (breaking)** — internal helpers were removed from the
  barrel; update payloads are fully precise, rejecting unknown keys in both
  literals and non-literal patches.
- Drift detection defaults to `'report'`; change-stream reconnects drop missed
  entries and retry with jittered backoff.
