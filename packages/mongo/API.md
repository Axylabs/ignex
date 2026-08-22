# API Reference — `@ignex/ninox`

Schema-first MongoDB ORM with performance as a first-class feature. Everything
below is exported from the package root (`@ignex/ninox`); the `./utils`
sub-path adds the zero-dependency utility bag.

Legend: **V** = value export (function/class/const) · **T** = type-only export.

---

## Schema DSL

The typed schema DSL drives TypeScript inference (`InferDoc`), the `$jsonSchema`
validator, and the query builder's field typing from one definition.

| Export | Kind | Purpose |
| --- | --- | --- |
| `s` | V | Field factory: `s.string/integer/number/double/long/decimal/boolean/date/objectId/array/enum/any/null/geoPoint/jsonSchema/object`. Each returns a chainable field (`.optional()`, `.default()`, `.name()`). |
| `optional` / `withDefault` | V | Standalone modifiers: `optional(field)` / `withDefault(field, value)`. |
| `s.object(props, { name })` | V | Object field; `{ name }` carries the collection name. |
| `s.jsonSchema(fragment)` | V | Raw `$jsonSchema` escape hatch — pass a `MongoJsonSchema` fragment through verbatim (`patternProperties`, `allOf`/`anyOf`/`oneOf`/`not`, `dependencies`, …). |
| `defineCollection(name, schema, { indexes?, hooks?, timestamps? })` | V | Name + schema + extras (indexes / hooks / timestamps). |
| `defineCollections(...)` | V | Derive a `collections` map keyed by schema names (duplicate names throw). |
| `toMongoSchema` / `toMongoValidator` | V | Convert a schema to `$jsonSchema` / the `{ $jsonSchema }` validator object. |
| `validateDoc` | V | Runtime read-side drift check: `validateDoc(schema, doc)` → `DriftIssue[]` (never mutates). |
| `DriftMode`, `DriftIssue`, `DriftIssueCode` | T | Drift policy (`'off' | 'report' | 'throw'`) / a single violation / its code. |
| `InferField` / `InferDoc` | T | Type-level inference: field type / document type from a schema. |
| `SchemaType`, `Chainable` | T | Schema union / chainable-modifier type. |
| `StringField`, `IntegerField`, `NumberField`, `DoubleField`, `LongField`, `DecimalField`, `BooleanField`, `DateField`, `ObjectIdField`, `ArrayField`, `ObjectField`, `EnumField`, `AnyField`, `NullField`, `GeoPointField`, `RawField` | T | Individual field kinds. |
| `NumberBounds` | T | Numeric constraints (`minimum`/`maximum`/`multipleOf`/`exclusiveMinimum`/`exclusiveMaximum`) shared by every numeric kind. |
| `FieldMeta`, `FieldFlags` | T | Base of every field + the `.flags` shape. |
| `MongoJsonSchema` | T | The emitted `$jsonSchema` shape (incl. `minItems`/`maxItems`/`uniqueItems`/`multipleOf`/`exclusive*`/`minProperties`/`maxProperties`). |
| `NamedObjectField`, `NamedCollectionDefinition`, `NamedCollection`, `CollectionName`, `CollectionValue`, `CollectionMap` | T | Named-collection inference helpers. |

## Core types

| Export | Kind | Purpose |
| --- | --- | --- |
| `DBClientDefinition` | T | One logical client: `{ name, dbUrl?, collections, collectionPrefix?, … }`. |
| `DbClientsDefinition` | T | Map of client keys → `DBClientDefinition`. |
| `CollectionDefinition`, `CollectionLike`, `CollectionDoc` | T | Collection shape (`schema` or `{ schema, indexes?, hooks?, timestamps? }`). |
| `IndexSpec` | T | `{ key, options? }` index declaration. |
| `CollectionTimestamps` | T | Auto-timestamp config (`createdAt`/`updatedAt` field names or `true`). |
| `ExtractDbNames`, `ExtractCollectionNames`, `ExtractCollectionType` | T | Type-level derivation of DB / collection names and doc types. |

## Errors

`AppError` → `DomainError` / `InfraError` / `BadRequest`.

| Export | Kind | Purpose |
| --- | --- | --- |
| `AppError` | V | Base error: `(code, message, statusCode, extra?)` + stable `toJSON()`. |
| `DomainError` | V | Expected business violation; `statusCode` refined per code: `NOT_FOUND` → 404, `DUPLICATE_KEY`/`VERSION_CONFLICT`/`COLLECTION_EXISTS`/`SCHEMA_DRIFT` → 409, `VALIDATION_FAILED` → 422 (else 400). |
| `InfraError` | V | Infrastructure failure; `MONGO_TIMEOUT` → 504 (else 500): `MONGO_QUERY_ERROR`, … |
| `BadRequest` | V | Malformed caller input (400, code `BAD_REQUEST`). |
| `isAppError` / `isDomainError` / `isInfraError` | V | Type guards. |
| `mapMongoDriverError` | V | Map a raw driver error → `AppError` (11000/112/50/121/bulk). |
| `isMappedMongoError`, `isMongoTransientError`, `isMongoDuplicateKeyError` | V | Predicates. |
| `TRANSIENT_MONGO_ERROR_CODES` | V | Server codes safe to retry. |
| `ERROR_HTTP_STATUS` | V | `code → HTTP status` table (404/409/422/504) used to set `statusCode`. |
| `httpStatusForError(err)` | V | Effective status for any thrown value (AppError-aware; raw → 500 / 503 transient). |
| `serializeError(err, ctx?)` | V | Reduce any thrown value to a stable `{ name, code, message, statusCode, extra? }` client payload (maps raw driver errors first). |
| `ErrorContext` | T | `{ db?, collection?, op? }` attached to mapped errors. |

Driver-error mapping is **on by default** (`wrapMongoErrors: false` to opt out).
For a framework, `serializeError(err)` is the one-liner that yields a client-safe
JSON payload with the correct `statusCode` — no parsing of server internals.

## Shared helpers

Backend-neutral, pure functions (no DB knowledge).

| Export | Kind | Purpose |
| --- | --- | --- |
| `DEFAULT_MAX_LIMIT` (1000) / `DEFAULT_FIND_LIMIT` (100) | V | Pagination / find defaults. |
| `MAX_BATCH_OPS` (100 000) | V | Hard cap for one `insertMany` / `bulkWrite` / `bulkUpsert` call. |
| `normalizePageLimit` | V | Validate page/limit → `{ page, limit, offset }` (throws `BadRequest` on NaN/out-of-range). |
| `buildPaginationResult` | V | Compute `PaginationResult` from data + total. |
| `buildMongoActiveFilter` / `mergeMongoActiveFilter` | V | Soft-delete active filters. |
| `stripDocumentId` / `stripPrimaryKey` | V | Remove `_id` from a doc. |
| `mergeMongoFilters` | V | `$and`-merge filters (later keys win). |
| `encodeCursor` / `decodeCursor` | V | Opaque keyset cursor codec (base64url). |
| `buildKeysetFilter` | V | Tuple-`$or` filter from sort keys + boundary values. |
| `PaginationResult`, `AggregationMeta`, `CrudListQuery`, `NormalizedPagination`, `RemoveIndexSignature`, `KeysetCursor`, `GeoPoint` | T | Result / helper types. |

## Utils (`@ignex/ninox` root and `@ignex/ninox/utils`)

| Export | Kind | Purpose |
| --- | --- | --- |
| `LRU` / `LRUOptions` | V/T | Dependency-free LRU cache. |
| `createCachedFactory` | V | Sync keyed factory cache. |
| `createCachedAsyncFactory` / `CacheOptions` | V/T | Async keyed cache with in-flight dedup; **failures are never cached**. |
| `createConsoleLogger` / `createNoopLogger` / `LoggerLike` / `LogFn` / `LogLevel` | V/T | Structured loggers. |
| `withTimeout` | V | Race a promise against a timeout. |
| `sleep` / `sleepJittered` | V | `setTimeout` promise / sleep with jittered backoff (used by change-stream reconnect loops). |
| `stableStringify` / `stableHash` / `hashString` | V | Deterministic, order-insensitive hashing (cache keys). |
| `cloneDeep` | V | Deep clone preserving `Date` / `ObjectId` / `RegExp`. |

## Mongo helpers / connection

| Export | Kind | Purpose |
| --- | --- | --- |
| `withRetry` / `RetryOptions` | V/T | Retry a fn on transient Mongo errors (exponential backoff; `maxAttempts` clamped ≥ 1). |
| `withTransaction` | V | Manual `start → run → commit/abort → endSession`. |
| `normalizeMongoUrl` | V | Normalize a connection string. |
| `createResolveCollectionName` | V | Build logical → physical name resolver (prefix/overrides). |

## Service (`createMongoService`)

| Export | Kind | Purpose |
| --- | --- | --- |
| `createMongoService` | V | Build the service (managers, health, connections). |
| `MongoService`, `MongoServiceConfig` | T | Service handle + config (`defaultDb`, `migrationDir`, `appName`, `logger`, `wrapMongoErrors`, `cache`, `cacheWatch`, `dedupeReads`, `perf`, `drift`). |
| `CacheInvalidator` / `CacheInvalidationRef` | V/T | `cacheWatch: true` opens `$changeStream` watchers so external writes invalidate the shared cache (replica sets only). |
| `CollectionManager` | T | Per-DB manager: CRUD + pagination + aggregation + schema (`createSchema`/`updateSchema`/`syncIndexes`) + transactions + `populate` + `client`. |
| `HealthReport`, `DbHealthResult` | T | `service.health()` output. |
| `CrudOps` | T | The manager's CRUD op surface. |

### Query options

`QueryOptions` (intersected into every op's options; `ResolvedQueryOptions` is the
driver/sdk split produced by `resolveQueryOptions`):

| Field | Purpose |
| --- | --- |
| `session` | Transaction session. |
| `maxTimeMS`, `hint`, `batchSize` | Driver knobs. |
| `maxAttempts`, `retryDelayMs` | Transient-error retry (reads only by default). |
| `retryWrites` | Opt-in write retry (**off by default** — writes are at-least-once). |
| `cache` | Per-op read-cache bypass (`false` skips). |
| `dedupe` | Per-op in-flight dedup override. |
| `drift` | Per-op schema-drift override for reads: `true` → `'throw'`, `false` → `'off'`, or a `DriftMode` string (default inherits service `drift`, then `'report'`). |
| `collation`, `readPreference`, `readConcern`, `writeConcern`, `comment`, `let`, `timeoutMS` | Forwarded untouched to the driver call. |

Related: `ResolvedQueryOptions<TDriverOpts>` — resolved retry/dedupe/cache flags
plus the `sdk` vs `driverOpts` split.

### CRUD (`CollectionManager` methods)

`getOne`, `getOneOrFail`, `findMany`, `findManyCursor`, `findActive`, `findActiveOne`,
`insertOne`, `insertMany`, `updateOne`, `updateMany`, `findOneAndUpdate`,
`findOneAndReplace`, `replaceOne`, `deleteOne`, `deleteMany`, `findOneAndDelete`,
`softDeleteOne`, `upsert`, `bulkUpsert`, `bulkWrite`, `updateWithVersion`,
`countDocuments`, `distinct`, `estimatedDocumentCount`, `watchCollection`, `query`.

Related types: `FindQueryOptions` (adds `select` projection), `InsertInput`,
`UpdateInput` / `UpdateOperators`, `FilterInput`, `VersionedUpdateResult`,
`TimestampsByCollection`.

### Pagination

| Export | Kind | Purpose |
| --- | --- | --- |
| `PaginationConfig`, `CursorPaginationConfig`, `CursorPage` | T | Config/result for `paginateFlexible` / `paginateCursor`. |

- `paginateFlexible` — `$facet` (count + data in one round trip, has totals).
- `paginateCursor` — keyset (O(log n), opaque `nextCursor`, no totals).

### Aggregation

| Export | Kind | Purpose |
| --- | --- | --- |
| `GroupByConfig`, `DateRangeConfig`, `LookupConfig`, `PipelineCustomization` | T | Aggregation-op configs. |
| `SearchConfig` | T | `textSearch` config (regex or `$text`, language, score-sort). |
| `AggregationStages` | T | Typed callback stage builder for `aggregate(stages => [...])`. |
| `PipelineBuilder` | T | Typed chained builder returned by `db.pipeline(collection)`. |

Manager ops: `aggregate`, `pipeline`, `groupBy`, `textSearch`, `dateRangeAnalysis`, `lookupJoin`.

### Pipeline type model (`src/service/pipeline-types.ts`)

`PipelineStage`, `FacetPipelineStage`, `LookupParams`, `FieldName`, `FieldRef`,
`Projection`, `Projected`, `Added`, `Unsetted`, `ExprResult`, `SortKeys`,
`AccumulatorSpec`, `AccumulatorResult`, `GroupSpec`, `Grouped`, `UnwindSpec`,
`Unwound`, `ForeignDocOf`, `LookupSpecFor`, `LookupJoinedFor`, `FacetSpec`,
`FacetOutput`, `GeoNearSpec`, `GeoNearOutput`.

## Query builder

| Export | Kind | Purpose |
| --- | --- | --- |
| `QueryBuilder` | V | Fluent, lazy, schema-typed find builder. |
| `QueryBuilderContext` | T | Its execution deps. |

`.where/.and/.or/.sort/.skip/.limit/.select/.project/.hint/.batchSize/.session/.maxTimeMS/.cache/.dedupe` → `.one()/.many()/.cursor()/.count()/.exists()`.

## Performance: loader, relations, cache, hot cache

| Export | Kind | Purpose |
| --- | --- | --- |
| `DataLoader` / `DataLoaderOptions` | V/T | Batching loader (microtask flush, per-key cache, `keyOf`). |
| `canonicalKey` | V | Canonical value key (ObjectId/Date-safe) — useful as `DataLoader` `keyOf`. |
| `belongsTo` / `hasMany` / `manyToMany` | V | Relation helpers (schema-validated, typed `as` fields). |
| `RelationDef`, `RelationDefBase`, `BelongsToRelation`, `HasManyRelation`, `ManyToManyRelation`, `ValidRelation`, `JoinedFields` | T | Relation types. |
| `PopulateOptions` | T | `{ maxBatchSize?, cache?, maxDocs? }` (maxDocs caps per-batch fetch, default 10 000). |
| `QueryCache` / `QueryCacheOptions` / `QueryCacheStats` | V/T | LRU+TTL read cache with per-collection invalidation; `set(key, value, ttlMs?, collections?, versions?)` registers an entry under additional source collections (aggregation joins) and stores per-collection versions captured at read-start (write-after-invalidate guard — `get()` treats a version-mismatched entry as stale); `versionOf(collection)`; `clone?: boolean`; `stats()` reports hits/misses/evictions/… |
| `cacheCollectionKey` | V | Compose a cache collection key namespaced by database (multi-DB isolation). |
| `InFlight` | V | Concurrent identical-query coalescing. |
| `SyncIndexesResult` | T | `{ created: string[]; dropped: string[] }` from `syncIndexes`. |
| `HotCache`, `createHotCache` | V | Global opt-in read-through cache (replica change streams / standalone ticker). `stats()` snapshots per-query `hits`/`misses`/`refreshes`/`loadErrors`/`sizeSkips`/`evictions`. |
| `HotCacheOptions`, `HotQueryConfig`, `HotCollectionRef`, `HotCacheMode`, `HotQueryAccessor`, `HotCacheStats`, `HotQueryStats` | T | Hot-cache config/types. `stop()` is terminal; `clone?: boolean`, `maxValueBytes?: number`, `mode?: 'replica'\|'standalone'` per config/query. |

## Hooks

| Export | Kind | Purpose |
| --- | --- | --- |
| `runHooks` | V | Run registered hooks for an event (no-op if none). |
| `HOOK_NAMES` | V | `before/afterCreate/Update/Delete`, `afterRead`. |
| `HookName`, `Hook`, `HookMap`, `HookContext`, `HooksRegistry` | T | Hook types. |

## Transactions & capabilities

| Export | Kind | Purpose |
| --- | --- | --- |
| `withGracefulMongoTransaction` / `MongoTransactionRunner` / `GracefulTransactionOptions` | V/T | Transaction-or-null fallback wrapper. |
| `probeMongoCapabilities` | V | Probe `hello` for replica support (timeout-guarded). |
| `createMongoCapabilitiesStore` / `MongoCapabilities` / `MongoCapabilitiesStore` | V/T | Cached capability store. |

The manager also exposes `transaction(fn(session|null), txnOptions?)` and `migrate(name, fn, filePath?)` (idempotent claim-based, transaction-safe).

## Migrations

| Export | Kind | Purpose |
| --- | --- | --- |
| `createMongoMigrationRunner` | V | File-based runner (`NNN_name.ts`, `_migrations` journal). |
| `MongoMigrationRunner`, `MongoMigrationRunnerOptions` | T | Runner interface: `up()`, `down()`, `status()`, `create(name)`. |
| `MigrationContext`, `MigrationModule` | T | Migration signature (`{ up, down }`). |

Journaling is claim-based: an atomic upsert claim (status `running` → `applied`)
prevents concurrent double-run; stale `running` rows are re-run after 60 s.

## Repository

| Export | Kind | Purpose |
| --- | --- | --- |
| `createRepository` | V | Bind a manager + collection into a domain-typed wrapper. |
| `Repository`, `RepositoryOptions` | T | Typed interface (`getById`, `create`, `updateVersioned`, `page`, `pageCursor`, `populate`, `watch`, …). |

See the service↔repository naming map in the README.

## Toolkit

| Export | Kind | Purpose |
| --- | --- | --- |
| `createMongoToolkit` | V | Bundle `createMongoService` + `createMongoMigrationRunner`. |
| `MongoToolkit`, `MongoToolkitOptions` | T | Toolkit handle/types. |
