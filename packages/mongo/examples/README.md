# ninox — runnable examples

Each example connects to a **uniquely-named local MongoDB database**, drops and
recreates every collection with its `$jsonSchema` validator, runs the scenario,
and closes the pool. Performance (query cache + in-flight dedup) is **ON by
default** — nothing needs enabling.

## Prerequisites

- A local MongoDB (default `mongodb://admin:admin@localhost:27017/`, override
  with `MONGO_URL`).
- Bun (`bun`).

## Run

```bash
bun run examples/01-crud.ts            # CRUD + optimistic locking
bun run examples/02-query-builder.ts   # fluent, schema-typed queries
bun run examples/03-pagination.ts      # $facet pagination (1 round trip)
bun run examples/04-relations.ts       # typed populate (belongsTo/hasMany/manyToMany)
bun run examples/05-cache-dedup.ts     # cache + dedup defaults & opt-outs
bun run examples/06-transactions.ts    # graceful transactions
bun run examples/07-aggregation.ts     # groupBy / dateRangeAnalysis / stages
bun run examples/08-migrations.ts      # file-based migrations + journal
bun run examples/09-perf-defaults.ts   # default-fast vs opted-out driver queries
bun run examples/10-typed-pipeline.ts  # db.pipeline() — type-safe aggregation
bun run examples/11-timestamps.ts      # auto createdAt/updatedAt
bun run examples/12-keyset-pagination.ts # cursor/keyset pagination
bun run examples/13-geo.ts             # s.geoPoint() + $geoNear
bun run examples/14-repository.ts      # createRepository() layer
bun run examples/15-hot-cache.ts       # global HotCache (replica watch / standalone ticker)
bun run examples/16-hooks.ts           # per-collection lifecycle hooks
bun run examples/17-crud-advanced.ts   # bulkWrite/bulkUpsert/distinct/replaceOne/findOneAndDelete/updateMany
bun run examples/18-health-watch.ts    # service.health() + eachDb + watchCollection
bun run examples/19-text-search.ts     # textSearch ($text/$regex) + lookupJoin
bun run examples/20-cache-watch.ts     # cacheWatch: change-stream cache invalidation
```

## What each shows

| File | Highlights |
| --- | --- |
| `01-crud.ts` | `insertOne/insertMany/getOne/getOneOrFail/findMany/updateOne/updateWithVersion/countDocuments/deleteMany` |
| `02-query-builder.ts` | `.where().or().select().limit().one()/many()/count()/exists()` + `.cache(false)/.dedupe(false)` |
| `03-pagination.ts` | `paginateFlexible` → data + total in one `$facet` call |
| `04-relations.ts` | `populate` with **type-checked** `collection/localField/foreignField/through` and **typed `as` fields** |
| `05-cache-dedup.ts` | cache hit = 0 driver calls; N concurrent reads = 1 call; opt-outs |
| `06-transactions.ts` | `transaction(fn(session))` + `withGracefulMongoTransaction` fallback |
| `07-aggregation.ts` | `groupBy`, `dateRangeAnalysis`, low-level `aggregate(stages => [...])` |
| `08-migrations.ts` | `createMongoMigrationRunner` over `fixtures/migrations/` |
| `09-perf-defaults.ts` | identical work, default ON vs opted out — driver-query counts |
| `10-typed-pipeline.ts` | `db.pipeline()` — chained type-safe aggregation: `$lookup` sub-pipelines scoped to the related collection, typed `$facet`, inferred results |
| `11-timestamps.ts` | `timestamps: true` collection option — `createdAt`/`updatedAt` stamped on insert + update |
| `12-keyset-pagination.ts` | `paginateCursor` — O(log n) cursor pagination with an opaque `nextCursor` |
| `13-geo.ts` | `s.geoPoint()` schema field + `$geoNear` stage with a `2dsphere` index |
| `14-repository.ts` | `createRepository(manager, collection)` — typed wrapper with `getById`/`create`/`page`/`populate` |
| `15-hot-cache.ts` | global `createHotCache()` — replica change-stream watch / standalone ticker, manual invalidation |
| `16-hooks.ts` | per-collection hooks: `before/afterCreate/Update/Delete` + `afterRead` |
| `17-crud-advanced.ts` | `bulkWrite`, `bulkUpsert`, `distinct`, `estimatedDocumentCount`, `replaceOne`, `findOneAndDelete`, `updateMany` |
| `18-health-watch.ts` | `service.health()` per-DB ping, `eachDb`, caller-owned `watchCollection` change stream |
| `19-text-search.ts` | `textSearch` (`$text` with score-sort / `$regex` fuzzy) + `lookupJoin` |
| `20-cache-watch.ts` | `cacheWatch: true` — `$changeStream` invalidation of the shared query cache on external writes (replica sets) |

## Shared pieces

- `shared/schema.ts` — the canonical schema registry. Collection names are
  carried by the schemas (`s.object({...}, { name })` / `defineCollection`) and
  derived with `defineCollections`, so a typo'd collection name is a **compile
  error** everywhere.
- `shared/setup.ts` — `connect(dbName)` / `close(ctx)` helpers + `MONGO_URL`.
