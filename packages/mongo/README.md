# ninox

**Schema-first MongoDB ORM for Bun & Node — typed, cached, and fast out of the box.**

Declare your collections once as TypeScript schemas. ninox turns that single definition into your types, a fluent query builder, and MongoDB `$jsonSchema` validation with indexes — then makes the everyday paths fast by default, so you can stop hand-rolling caches and N+1 workarounds.

**Node ≥ 18.17** · **Bun ≥ 1.0** · **TypeScript ≥ 5.5** (optional) · **MongoDB 4.4+** · **MIT**

## Why you'll like it

- 🧠 **One schema, three jobs.** A single `s.*` schema produces your TypeScript types, the query builder's autocomplete, and the DB validator + indexes. One source of truth, nothing to keep in sync.
- ⚡ **Fast by default.** Read caching and in-flight dedup are on out of the box — repeated queries make *zero* DB calls, and identical concurrent queries share one.
- 🔗 **Relations without the N+1.** `populate()` batches lookups into a few `$in` queries, no matter how many related docs you load.
- 📄 **One-round-trip pagination.** Data and total count from a single `$facet` call, plus cursor (keyset) pagination that stays cheap on deep pages.
- 🛡️ **Errors you can actually handle.** Driver errors are mapped to a small taxonomy (`BadRequest` / `DomainError` / `InfraError`) with HTTP statuses and a client-safe serializer.
- 🔥 **A cache that stays fresh by itself.** The global HotCache serves your hottest queries from memory and keeps them fresh with change streams (replica sets) or a background refresh ticker (standalone) — reads never block.
- 🏭 **Production touches built in.** Graceful transactions, file-based migrations, health checks, multi-DB services, a high-throughput hot cache, and an opt-in schema-drift guard.

## ninox vs native MongoDB vs Mongoose

Built on the official `mongodb` driver, but with the ergonomics of an ORM and
the performance you wouldn't expect from one. Side by side:

| | ninox | native `mongodb` driver | Mongoose |
| --- | --- | --- | --- |
| One schema → types + queries + DB validation | ✅ `InferDoc` + typed everything | 🟡 manual `<TDoc>` generics | 🟡 schemas, loose query typing |
| Validation enforcement | ✅ DB-level `$jsonSchema`, strict by default | ❌ you write `$jsonSchema` yourself | 🟡 client-side only, no DB validator |
| Read query cache (repeat reads = **0** round trips) | ✅ on by default | ❌ none | ❌ none |
| In-flight dedup (N identical reads → **1** call) | ✅ on by default | ❌ none | ❌ none |
| Relations without N+1 | ✅ DataLoader-batched `populate` | ❌ manual | 🟡 `populate`, can N+1 |
| Pagination in one round trip | ✅ `$facet` + keyset cursors | ❌ manual | 🟡 count + find (2 round trips) |
| Typed aggregation pipeline | ✅ stage-by-stage inferred types | ❌ untyped | ❌ loosely typed |
| Optimistic locking / soft delete | ✅ `updateWithVersion` / `softDeleteOne` | ❌ manual | 🟡 manual / plugin |
| Lifecycle hooks | ✅ `before/after` + `afterRead` | ❌ | ✅ |
| Hot cache (change-stream / background refresh) | ✅ | ❌ | ❌ |
| Error taxonomy + driver mapping | ✅ `BadRequest` / `DomainError` / `InfraError` | ❌ raw driver errors | 🟡 scattered error types |
| File-based migrations | ✅ runner + idempotency journal | ❌ | 🟡 plugin |
| Health checks + multi-DB | ✅ per-DB pings, namespaced caches | ❌ | 🟡 |
| Change tracking / doc magic | none — explicit load → mutate → persist | — | 🟡 dirty-checking overhead |
| Runtime | ✅ Bun & Node, ESM-first | ✅ | 🟡 Node-first |

**The headline numbers** (localhost, seeded with 200 users / 1000 orders):

| scenario | naive | ninox |
| --- | --- | --- |
| populate 100 orders | 17,000 queries (N+1) | **340 queries** (~50× fewer round trips, ~6× faster) |
| 50 concurrent identical reads | 50 server queries, 17 ms | **1 server query**, 1.5 ms |
| cache hit | 1 driver call | **0 driver calls** |
| deep aggregation (multi-`$lookup` join) | 17,000 queries (N+1) | **170 queries** (~100× fewer round trips) |

And you're never locked in — the raw `client` escape hatch is one property away
when you need driver-level access. [Full benchmark](#performance) ·
[Run the examples](#examples)

## Flagship features

Three capabilities that set ninox apart — the ones you'll reach for when you need to go from "it works" to "it's fast and observable".

### 🔥 Hot cache — keep your hottest queries in memory

Register the queries that run on every request with one global `createHotCache()`. Reads are served from a per-query LRU (call parameters become the cache key), so the DB is only touched on a cold miss. On a replica set, change-stream watchers invalidate the cache the moment a write lands — even from other processes. → [Full guide](#hot-cache-high-throughput)

### 🔄 Background refresh — a self-updating cache

On standalone servers (no change streams), a global background ticker re-fetches your registered queries on an interval and swaps in fresh values — a stale value keeps being served until the replacement arrives, so **reads never block**. Opt in per query with `refreshIntervalMs`, or drive freshness entirely by hand (`autoRefresh: false`). → [Background refresh system](#background-refresh-system)

### 🪝 MongoDB lifecycle hooks — middleware for your data

Per-collection `before/after` hooks for create, update, and delete, plus `afterRead`. Declare them on the collection and they fire around every ORM op — audit logging, cache invalidation, sensitive-field masking, you name it. `afterRead` runs on every read (cache hit or miss) with a fresh per-caller clone, so hooks can never poison the cache. → [Hooks guide](#hooks)

## Install

```bash
# bun
bun add @ignex/ninox mongodb

# npm
npm install @ignex/ninox mongodb

# pnpm / yarn
pnpm add @ignex/ninox mongodb
```

`mongodb` is ninox's **only runtime dependency**. TypeScript is optional — plain JS works too, you just lose the inferred types.

**Requirements**

- Node ≥ 18.17 (ESM) or Bun ≥ 1.0
- MongoDB server 4.4+ (5.1+ for `$fill` / `$densify`)
- Transactions, change streams, and change-stream cache invalidation need a **replica set or `mongos`**

## Quick start

```ts
import {
  createMongoToolkit,   // service + migrations
  s,
  defineCollection,     // name + schema + optional indexes/hooks
  defineCollections,    // derive the collections map from named schemas
  belongsTo,
  type InferDoc,
} from '@ignex/ninox';

// 1. Describe your collections. Names live on the schema itself.
const userSchema = s.object({
  _id: s.objectId(),
  email: s.string(),
  role: s.enum(['admin', 'user'] as const),
  createdAt: s.date(),
}, { name: 'users' });
type User = InferDoc<typeof userSchema>;

const orderSchema = s.object({
  _id: s.objectId(),
  userId: s.objectId(),
  total: s.number({ minimum: 0 }),
}, { name: 'orders' });
type Order = InferDoc<typeof orderSchema>;

// 2. Attach a name (plus optional indexes and hooks), then derive the map.
const users = defineCollection('users', userSchema, {
  indexes: [{ key: { email: 1 }, options: { unique: true } }],
  hooks: { beforeCreate: (ctx) => console.log('creating', ctx.doc?.email) },
});

const { service } = createMongoToolkit({
  primary: {
    name: 'app',
    dbUrl: process.env.MONGO_URL,
    collectionPrefix: process.env.DB_PREFIX,   // physical name: `app-users`
    collections: defineCollections(users, orderSchema),
  },
});
// Query cache + in-flight dedup are ON by default — nothing to enable.

// 3. Connect, install the validator + indexes, and start reading & writing.
await service.makeConnections();
const db = service.db.primaryClient;           // fully typed manager

await db.createSchema('users');

const { insertedId } = await db.insertOne('users', {
  email: 'ada@example.com', role: 'admin', createdAt: new Date(),
});

// Fluent query builder — projections are pushed down to the driver.
const admins = await db.query('users')
  .where({ role: 'admin' })
  .select(['_id', 'email'])
  .limit(10)
  .many();

// $facet pagination — data + count in one round trip.
const page = await db.paginateFlexible(
  'orders',
  { userId: insertedId },
  { page: 1, limit: 20, sort: { total: -1 } },
);

// DataLoader-batched population — no N+1.
const orders = await db.findMany('orders', { userId: insertedId });
await db.populate(orders, [
  belongsTo({ collection: 'users', localField: 'userId', as: 'customer' }),
]);

// Optimistic locking.
const result = await db.updateWithVersion('users', { _id: insertedId }, { $set: { role: 'user' } });

// Transactions — gracefully fall back on standalone servers.
await db.transaction(async (session) => {
  await db.insertOne('orders', { userId: insertedId, total: 5 }, { session: session ?? undefined });
});

await service.closeConnections();
```

## Key features

A quick tour — each entry links to the full guide further down.

| | Feature | What it does for you |
| --- | --- | --- |
| 🧠 | [Schema DSL](#schema-dsl-reference) | One schema → types, typed queries, and DB validation |
| 🔎 | [Query builder + CRUD](#query-builder--full-crud) | Fluent, typed queries; the full insert/update/delete/upsert family |
| ⚡ | [Cache + dedup](#performance-by-default) | 0 round trips on repeat reads; N identical reads → 1 DB call |
| 🔗 | [Relations + DataLoader](#relations--populate) | `belongsTo` / `hasMany` / `manyToMany` without N+1 |
| 📄 | [Pagination](#pagination-offset--keyset) | `$facet` (data + count, 1 round trip) + keyset cursors |
| 📊 | [Typed aggregation](#typed-aggregation-pipeline) | Chainable `pipeline()` with inferred result types — materialized results are cached |
| 🔍 | [Search & joins](#search--joins) | `$text` / regex search + single-hop `lookupJoin` |
| 🗺️ | [Geospatial](#geospatial) | `s.geoPoint()` + typed `$geoNear` with distances |
| 📦 | [Repository layer](#repository-layer) | Optional domain-typed wrapper (`getById`, `create`, `page`, …) |
| ⏱️ | [Auto timestamps](#auto-timestamps) | `createdAt` / `updatedAt` for free, custom names supported |
| 🔁 | [Transactions & migrations](#transactions--migrations) | Graceful sessions + file-based runner with a journal |
| 🔥 | [Hot cache](#hot-cache-high-throughput) | Change-stream / ticker-driven in-memory query cache |
| 🔄 | [Background refresh](#background-refresh-system) | Self-updating standalone cache — reads never block |
| 🧹 | [Data invalidation](#data-invalidation-react-query-style) | React Query-style — invalidate by name, params, or collection |
| 🛡️ | [Error handling](#error-handling) | `BadRequest` / `DomainError` / `InfraError` + HTTP mapping |
| ✅ | [Validation & drift](#validation) | DB `$jsonSchema` (strict) + opt-in drift detection |
| 🪝 | [Mongo hooks](#hooks) | `before/after` create/update/delete + `afterRead` |
| 🩺 | [Health & multi-DB](#operations-health--multi-db) | Per-DB pings, multi-client services, change-stream watch |

## Typed aggregation pipeline

`db.pipeline(collection)` is a chainable, fully type-safe aggregation builder.
Each stage is typed against the **current** document shape — field autocomplete
and the inferred result type follow the schema through `$match` / `$project` /
`$addFields` / `$group` / `$sort` / `$unwind` / `$lookup` / `$facet` and beyond.

```ts
// The result type is inferred through the chain.
const byStatus = await db
  .pipeline('orders')
  .match({ status: 'paid' })                                  // Order fields autocomplete
  .group({ _id: '$status', revenue: { $sum: '$total' } })     // → { _id: Order['status']; revenue: number }
  .sort({ revenue: -1 })
  .limit(10)
  .toArray();

// $lookup sub-pipelines are scoped to the related collection's schema:
// inside the callback, `o` autocompletes Order fields and `orders` is typed as
// the sub-pipeline output (Array<{ _id; total }> here, since `status` was dropped).
const withOrders = await db
  .pipeline('users')
  .lookup({
    from: 'orders', localField: '_id', foreignField: 'userId', as: 'orders',
    pipeline: (o) => o.match({ total: { $gte: 50 } }).project({ total: 1 }),
  })
  .toArray();

// $facet branches each get their own typed sub-builder:
// → { byStatus: Array<{ _id; count: number }>; top3: Order[] }
const faceted = await db
  .pipeline('orders')
  .facet({
    byStatus: (s) => s.group({ _id: '$status', count: { $sum: 1 } }),
    top3: (s) => s.sort({ total: -1 }).limit(3),
  })
  .toArray();
```

Terminals: `.toArray()`, `.first()`, `.cursor()`. The callback
`db.aggregate('orders', (stages) => [...])` is collection-typed too (its
`match` / `project` / `sort` / `group` / `lookup` / `facet` are checked against
the schema); reach for `db.pipeline()` when you also want inferred result types.
See [`examples/10-typed-pipeline.ts`](./examples/10-typed-pipeline.ts).

> ⚡ **Aggregation results are cached too.** `pipeline().toArray()/.first()`,
> `groupBy`, `dateRangeAnalysis`, `textSearch`, `lookupJoin`, and
> `paginateFlexible` route through the same write-through `QueryCache` as flat
> reads (warm reads = **0 driver calls**). Invalidation is write-through and
> per-source: a `$lookup`/`$unionWith` join is registered under **every** source
> collection, so a write to any of them drops it. Pipelines that write
> (`$out`/`$merge`) or are non-deterministic (`$sample`) are never cached; use
> `{ cache: false }` for other non-deterministic pipelines (`$rand`/`$function`).
> Live cursors — `aggregate()` and `pipeline().cursor()` — stream and are not
> cached.

## Query builder & full CRUD

Fluent queries: `.where().or().sort().skip().limit().select().hint()` →
`.one() / .many() / .cursor() / .count() / .exists()`. Projections are pushed
down to the driver, so you only transfer the fields you asked for.

The full CRUD family — all typed, all cache-aware:

`getOne` / `getOneOrFail` / `findMany` / `cursor` / `findActive*` / `insertOne` /
`insertMany` / `updateOne` / `updateMany` / `findOneAndUpdate` /
`findOneAndReplace` / `replaceOne` / `findOneAndDelete` / `delete*` /
`softDeleteOne` / `upsert` / `bulkUpsert` / `bulkWrite` / `distinct` /
`countDocuments` / `estimatedDocumentCount` / `watchCollection` /
`updateWithVersion` (optimistic `__v` locking).

## Schema DSL reference

One `s.*` schema drives three things at once: the TypeScript document type
(`InferDoc`), the field typings for filters / updates / pipelines / the query
builder, and the MongoDB `$jsonSchema` validator + indexes installed by
`createSchema`. Fields are chainable (`.optional()`, `.default(v)`);
`optional` / `withDefault` are also exported standalone.

| field kind | `s.*` | inferred TS type |
| --- | --- | --- |
| string / int / number | `s.string()` / `s.integer()` / `s.number()` | `string` / `number` / `number` |
| exact BSON kinds | `s.double()` / `s.long()` / `s.decimal()` | `number` / `number` / `Decimal128` |
| other scalars | `s.boolean()` / `s.date()` / `s.objectId()` | `boolean` / `Date` / `ObjectId` |
| enum | `s.enum(['a', 'b'] as const)` | `'a' \| 'b'` (string or numeric literals) |
| array | `s.array(s.string())` | `string[]` |
| object | `s.object({ ... })` | nested object (optional/default keys are optional) |
| geo | `s.geoPoint()` | `GeoPoint` = `{ type: 'Point'; coordinates: [number, number] }` |
| nullable / any | `s.null()` / `s.any()` | `null` / `unknown` |
| raw escape hatch | `s.jsonSchema({ ... })` | `unknown` (fragment passed through verbatim) |

Constraints mirror `$jsonSchema`: strings (`minLength` / `maxLength` / `pattern`),
numbers (`minimum` / `maximum` / `multipleOf` / `exclusiveMinimum` /
`exclusiveMaximum`), arrays (`minItems` / `maxItems` / `uniqueItems`), objects
(`minProperties` / `maxProperties` / `additionalProperties`). `format` is
accepted but a no-op (MongoDB rejects the `$jsonSchema` keyword).

```ts
const userSchema = s.object({
  _id: s.objectId(),
  email: s.string({ minLength: 3, maxLength: 254, pattern: '^[^@]+@[^@]+$' }),
  age: s.integer({ minimum: 0 }).optional(),
  role: s.enum(['admin', 'user'] as const).default('user'),
  tags: s.array(s.string(), { maxItems: 10 }),
  meta: s.object({ lastLogin: s.date().optional() }, { additionalProperties: true }),
  score: s.decimal().optional(),   // → Decimal128
  home: s.geoPoint().optional(),   // → GeoPoint
}, { name: 'users' });
type User = InferDoc<typeof userSchema>;
```

> 💡 **Good to know:** ninox reserves `_id`, the optimistic-lock `__v`, and the
> soft-delete `deletedAt` in the validator automatically — strict validation
> never rejects them even when your schema omits them.

## Pagination (offset + keyset)

Two styles, both cheap on the server:

- `paginateFlexible` — offset `$facet` pagination: **data and total in one round
  trip** (`{ data, page, limit, totalCount, totalPages }`).
- `paginateCursor` — keyset/cursor pagination: O(log n) per page (no deep
  `$skip`), stable under concurrent inserts, returns an opaque `nextCursor`.

```ts
// $facet — data + count in one round trip:
const page = await db.paginateFlexible(
  'orders',
  { status: 'paid' },
  { page: 1, limit: 20, sort: { total: -1 } },
);

// Keyset — walk pages with an opaque cursor (sort needs a unique tiebreaker):
const sort = { createdAt: -1, _id: 1 };
let cursor: string | undefined;
do {
  const p = await db.paginateCursor('orders', { userId }, { sort, limit: 5, after: cursor });
  console.log(p.data, p.hasMore ? '(more)' : '(last)');
  cursor = p.nextCursor ?? undefined;
} while (cursor);
```

`paginateCursor` supports `after` (forward) and `before` (backward); a sort whose
keys don't match the cursor's is rejected at runtime.

## Geospatial

`s.geoPoint()` declares a GeoJSON `Point`, and the `$geoNear` pipeline stage
(which MUST be the first stage) returns results sorted by distance with a
computed distance field. Requires a `2dsphere` index on the field.

```ts
const places = defineCollection('places', placeSchema, {
  indexes: [{ key: { location: '2dsphere' } }],
});

const nearest = await db
  .pipeline('places')
  .geoNear({
    near: { type: 'Point', coordinates: [-74.006, 40.7128] }, // GeoJSON Point, NOT [lng, lat]
    distanceField: 'dist',
    spherical: true,
  })
  .limit(3)
  .toArray(); // each doc gains `dist` (meters with spherical: true)
```

## Search & joins

- `textSearch` — `$text` mode (requires a text index on the searched fields) or
  `$regex` mode (`useRegex: true`, no index needed) across one or more fields,
  with `$facet` pagination, `sortByScore`, `$language`, and `$diacriticSensitive`.
- `lookupJoin` — a single-hop `$lookup` with optional `$unwind`, typed per
  collection.

```ts
// $text search (needs a text index on the searched fields):
await db.client.collection('products').createIndex({ name: 'text' });
const hits = await db.textSearch(
  'products',
  {},
  { searchFields: ['name'], searchTerm: 'gadget', sortByScore: true },
  { page: 1, limit: 10 },
);

// Single-hop join, unwound into `customer`:
const joined = await db.lookupJoin<'orders', Order & { customer?: User }>('orders', {}, [{
  fromCollection: 'users',
  localField: 'userId',
  foreignField: '_id',
  as: 'customer',
  unwindSingle: true,
}]);
```

## Relations + populate

`populate()` resolves schema-validated relations with **batched `$in` queries**
(no N+1). `belongsTo`, `hasMany`, and `manyToMany` are type-checked at the call
site — collection names, local/foreign fields, and the join collection are all
validated against the schema registry.

```ts
import { belongsTo, hasMany, manyToMany } from '@ignex/ninox';

// belongsTo → `customer` is `User | null`
const orders = await db.findMany('orders', {});
await db.populate(orders, [
  belongsTo({ collection: 'users', localField: 'userId', as: 'customer' }),
  hasMany({ collection: 'orders', localField: '_id', as: 'more' }),
]);

// manyToMany through the join collection → `tags` is `Tag[]`
await db.populate(products, [
  manyToMany({
    collection: 'tags',
    localField: '_id',
    as: 'tags',
    through: { collection: 'product_tags', localField: 'productId', foreignField: 'tagId' },
  }),
]);
// orders[0].customer, orders[0].more, products[0].tags are all typed.
```

## Repository layer

`createRepository(manager, 'collection')` wraps a manager + collection into a
collection-free, domain-typed interface. No change tracking — load → mutate →
persist is explicit, matching the core op semantics.

```ts
import { createRepository } from '@ignex/ninox';
const users = createRepository(db, 'users');

const { insertedId } = await users.create({ email, role: 'admin', createdAt: new Date() });
const u = await users.getById(insertedId);
await users.update(insertedId, { $set: { role: 'user' } });
const page = await users.page({ role: 'admin' }, { page: 1, limit: 20 });
```

## Auto timestamps

Set `timestamps` on a collection definition and ninox stamps `createdAt` /
`updatedAt` on insert and `updatedAt` on every update (including upserts and
replacements).

```ts
const users = defineCollection('users', userSchema, {
  // true → createdAt + updatedAt; or { createdAt: 'c_at', updatedAt: 'u_at' }
  timestamps: true,
});
```

## Transactions & migrations

- `db.transaction(async (session) => ...)` — graceful session transactions with a
  capability probe; on standalone servers (no transactions) it falls back to
  plain non-transactional execution with `session === null`.
- `createMongoMigrationRunner(service, { migrationDir })` — file-based migrations
  (`NNN_name.ts`, each exporting `up` / `down`) with a claim-based idempotency
  journal (`_migrations`), safe under concurrent runners.

```ts
const runner = createMongoMigrationRunner(service, { migrationDir: './migrations' });
await runner.up();                 // apply pending migrations in numeric order
await runner.down('001_seed');     // roll back to a target migration
await runner.scaffold('add_tags'); // create a new NNN_add_tags.ts template
```

## Performance by default

The **default path is the fast path.** A `QueryCache` and in-flight dedup are
created and enabled automatically — repeated identical reads become cache hits
(0 driver calls) and identical concurrent reads coalesce into one driver call.
The same applies to **materializing aggregation results** (`pipeline().toArray()`
/ `.first()`, `groupBy`, `dateRangeAnalysis`, `textSearch`, `lookupJoin`,
`paginateFlexible`) — they share the same cache, with invalidation per source
collection. Opt out when you need to:

```ts
// Service-wide: disable caching, dedup, or everything at once.
createMongoService(clients, { cache: null });           // no read cache
createMongoService(clients, { dedupeReads: false });    // no dedup
createMongoService(clients, { perf: false });           // both off
createMongoService(clients, { cache: { maxSize: 1000 } }); // configure the default cache

// Per-op / per-query:
db.findMany('users', {}, { cache: false, dedupe: false });
db.query('users').where({ role: 'admin' }).cache(false).dedupe(false).many();

// Field projection on flat find queries — only the listed fields are transferred.
db.findMany('users', {}, { select: ['_id', 'email'] });
db.getOne('users', { email: 'ada@example.com' }, { select: ['email'] });
```

Pass a `QueryCache` instance you own to read cache health — `cache.stats()`
reports current size plus lifetime `hits` / `misses` / `sets` / `deletes` /
`invalidateEvents` / `clearEvents` / `evictions` (hit rate is the key signal).

> ⚠️ **Cache invalidation is write-through only.** Every ninox write drops that
> collection's cached reads, but reads are **not** invalidated by external
> writers — other processes, the raw `client` escape hatch, or direct DB
> writes. With the default `ttlMs: 0` those reads stay stale indefinitely, so
> multi-writer deployments should set `cache: { ttlMs }`, disable the cache,
> route latency-critical reads through the change-stream-aware
> [`createHotCache()`](#hot-cache-high-throughput), or — on a replica set — opt
> into `cacheWatch: true`:
>
> ```ts
> createMongoService(clients, { cacheWatch: true }); // change-stream invalidation
> ```
>
> `cacheWatch` opens one `$changeStream` watcher per registered collection so
> even external writes invalidate the shared cache. It requires a replica set /
> mongos; on standalone servers the streams are rejected, a warning is logged
> once, and invalidation silently disables (the cache stays write-through only).

## Hot cache (high throughput)

For workloads that **can't afford DB latency per request**, register the hot
queries with one global `createHotCache()` instance. Reads are served from a
per-query LRU (call parameters become the cache key), and the cache stays fresh
based on the deployment:

- **Replica set / mongos** → change-stream watchers on the bound collections
  invalidate the cache the moment a write lands — even from other processes.
- **Standalone** (no change streams) → a global ticker background-refreshes
  entries at `refreshIntervalMs` (per-query, default `0` = off); stale values
  keep being served until the fresh value swaps in (reads never block). Queries
  with neither `refreshIntervalMs` nor `ttlMs` set serve values until manually
  invalidated — `start()` logs a warning naming them (unbounded staleness).

```ts
import { createHotCache, probeMongoCapabilities } from '@ignex/ninox';

const hot = createHotCache({
  // Auto-detect: replicas → change streams, standalone → ticker.
  probe: async () => (await probeMongoCapabilities(db.client)).transactionsSupported,
});

const topProducts = hot.register('topProducts', {
  loader: async (limit: number) => db.findMany('products', {}, { limit }),
  watch: [{ db: db.client, collection: 'products' }], // physical collection name
});
const orderStats = hot.register('orderStats', {
  refreshIntervalMs: 500, // standalone: the ticker keeps this fresh
  loader: async () => db.countDocuments('orders', {}),
});

const mode = await hot.start(); // 'replica' | 'standalone'
const products = await topProducts.get(3); // cold → loader, warm → LRU

// Manual invalidation — full control over staleness:
topProducts.invalidate();              // drop all entries
topProducts.invalidate(3);             // drop just the { limit: 3 } entry
hot.invalidateParams('topProducts', 3); // same, via dynamic name lookup
hot.invalidateCollection('products');  // drop every query watching that collection
await hot.stop();                      // close streams + ticker
```

`register()` returns a **fully typed accessor** — `topProducts.get(limit)` and
`topProducts.invalidate(limit)` have complete intellisense on the loader
parameters. Loader errors are never cached (they retry on the next read), and
concurrent identical reads are in-flight-deduped. `has(name)` checks whether a
query is registered.

Set `autoRefresh: false` to **turn off the global auto-refetch** entirely — the
standalone ticker never runs, so data only updates via manual invalidation or
`ttlMs` expiry. This keeps the DB from being polled when you'd rather drive
freshness explicitly (replica-mode change streams are event-driven and
unaffected):

```ts
const hot = createHotCache({ probe, autoRefresh: false, defaultTtlMs: 5_000 });
```

Pin the mode to skip the probe entirely when you already know the deployment
(`mode: 'replica'` / `mode: 'standalone'`), and use `hot.stats()` for
observability — it reports per-query `hits` / `misses` / `refreshes` /
`loadErrors` / `sizeSkips` plus current sizes. Cap runaway single entries with a
per-query `maxValueBytes` (larger values are still returned, just not cached).

Cached results are shared **by reference** (zero clone overhead); if a caller might
mutate a result, enable per-query `clone: true` (or `cache: { clone: true }`) so
each read returns a fresh copy and can't poison the cache.

### Failure semantics — the staleness window

Freshness is best-effort under failure: while the background freshness
mechanism is down, the HotCache keeps serving from memory, so **low latency can
hide stale reads**. Here is exactly what happens in the failure cases that
matter, and how the cache self-heals:

| failure | what happens | recovery |
| --- | --- | --- |
| **Stream error / server kill** (network drop, replica failover) | watcher logs `hot cache change stream error`, closes the stream, retries with jittered backoff (1s → 5s) | on **reopen** the bound collection is invalidated once — entries that could have gone stale during the outage are re-fetched on the next read |
| **Resume-token expiry** (`ChangeStreamHistoryLost` — the oplog pruned past the stream's token) | treated as a *recoverable* error, NOT "unsupported" → same backoff/retry path; the re-opened stream has no resume token and starts from "now" | invalidate-on-reopen drops any entries that missed changes during the gap; the next read re-fetches |
| **Rollback / `invalidate` events** (collection dropped/renamed) | the stream emits `invalidate` and ends | the loop reconnects and invalidates on reopen |
| **Consumer downtime** (the process hosting the watcher is down/paused) | writes are NOT observed, so the in-process LRU keeps serving stale values | once the watcher reconnects, invalidate-on-reopen drops the collection's entries and the next read is fresh; a consumer that never reconnects leaves entries stale forever unless `ttlMs`/`refreshIntervalMs` are set |

To **bound the staleness window itself** (not just recover from it):

- set per-query `ttlMs` (expiry) and/or `refreshIntervalMs` (background
  refresh) — `refreshIntervalMs` also keeps the cache self-updating even if the
  watcher never comes back;
- watch `hot.stats()` (per-query `hits` / `misses` / `refreshes` / `loadErrors`)
  and the `hot cache change stream reconnected` / `hot cache change stream
  error` warnings — a rising `misses`-to-`hits` ratio or repeated reconnect
  warnings mean the watcher is unhealthy;
- in standalone mode, queries with neither `refreshIntervalMs` nor `ttlMs` are
  served until manually invalidated (see the standalone warning below).

## Background refresh system

The standalone-mode workhorse behind the HotCache: a single global background
ticker that keeps your registered queries fresh without a request ever blocking
on the DB.

**How it works**

- Every `tickIntervalMs` (default `1000` ms) the ticker scans the registered
  queries and re-runs the loaders for any entry whose `refreshIntervalMs` is due.
- Fresh values **swap in behind the scenes** — a stale value keeps being served
  until the replacement arrives, so reads never wait on a refresh.
- If a background refresh fails (transient error, DB hiccup), the stale value is
  retained, a warning is logged, and the entry retries on the next pass — you
  never serve an error where a cached value would do.
- Only queries that opt in with `refreshIntervalMs` are refreshed. A query with
  neither `refreshIntervalMs` nor `ttlMs` is served until manually invalidated —
  `start()` logs a warning naming those queries so you can opt in deliberately.

**Configuration**

```ts
const hot = createHotCache({
  probe,                    // auto-detect replica vs standalone
  tickIntervalMs: 1000,     // how often the background ticker runs
  autoRefresh: true,        // master switch for the ticker (default true)
});

// Per-query: refresh this entry every 500ms in the background.
hot.register('orderStats', {
  refreshIntervalMs: 500,
  loader: async () => db.countDocuments('orders', {}),
});

// Prefer full control? Turn the ticker off and drive freshness yourself:
const manual = createHotCache({ probe, autoRefresh: false, defaultTtlMs: 5_000 });
```

On a replica set the same freshness is delivered event-driven by change streams
instead — see [Hot cache](#hot-cache-high-throughput).

## Data invalidation (React Query style)

If you've used TanStack Query, ninox's cache invalidation will feel familiar —
same ideas of query keys, invalidation by key, and automatic refetch. Here's the
mapping:

| React Query | ninox |
| --- | --- |
| `queryKey` | the cache key — HotCache: **query name + call parameters**; query cache: **collection + filter/pipeline hash** |
| `queryClient.invalidateQueries(['products'])` | `hot.invalidateCollection('products')` or `hot.invalidate('topProducts')` |
| invalidating one exact entry | `hot.invalidateParams('topProducts', 3)` / `topProducts.invalidate(3)` |
| `refetchInterval` (background refetch) | the standalone [background ticker](#background-refresh-system) (`refreshIntervalMs`) |
| `staleTime` / `gcTime` | `ttlMs` (per-query, or `defaultTtlMs` on the HotCache) |
| refetch after a mutation | **automatic** — every ninox write invalidates that collection's cache, no wiring needed |

**What keeps the cache correct, by default:**

1. **Write-through invalidation.** Every ORM insert/update/delete drops that
   collection's cached reads — and every cached aggregation result that reads it
   (via its source collections) — immediately, like React Query invalidating on a
   mutation, but you never have to call it.
2. **External-writer protection.** Writes from other processes, the raw `client`
   escape hatch, or direct DB access can't invalidate on their own. Three ways to
   stay correct in multi-writer deployments:
   - set `cache: { ttlMs }` so stale entries expire,
   - turn on `cacheWatch: true` (replica sets) so change streams invalidate the
     shared cache on external writes too, or
   - route hot reads through `createHotCache()`.

**The invalidation API at a glance:**

```ts
// Query cache — invalidated automatically on every ORM write.
db.insertOne('orders', order); // drops all cached 'orders' reads

// HotCache — manual invalidation, React Query style:
topProducts.invalidate();              // drop every entry for this query
topProducts.invalidate(3);             // drop just the { limit: 3 } entry
hot.invalidateParams('topProducts', 3); // same, via dynamic name lookup
hot.invalidateCollection('products');  // drop every query bound to 'products'

// Or let the cache invalidate itself:
hot.register('topProducts', {
  loader: async (limit: number) => db.findMany('products', {}, { limit }),
  watch: [{ db: db.client, collection: 'products' }], // change-stream invalidation (replica)
  refreshIntervalMs: 500,                            // background refetch (standalone)
});
```

One difference worth knowing: there's no component tree here. Invalidation is
collection-scoped and happens at the data layer, so *any* client (API, worker,
CLI) shares the same cache instead of one per component.

## Error handling

ninox throws a small error taxonomy (`ninox` exports all of them):

| Error | Meaning | HTTP |
| --- | --- | --- |
| `BadRequest` | Malformed caller input (`BAD_REQUEST`) | 400 |
| `DomainError` | Expected business violation — `NOT_FOUND`, `DUPLICATE_KEY`, `VERSION_CONFLICT`, `VALIDATION_FAILED`, `SCHEMA_DRIFT`, `COLLECTION_EXISTS`, … | 404 / 409 / 422 (code-dependent, else 400) |
| `InfraError` | Infrastructure failure — `MONGO_TIMEOUT`, `MONGO_QUERY_ERROR`, … | 504 / 500 |

`mapMongoDriverError` converts raw driver errors (11000 dup, 112 conflict, 50
Timeout, 121 validation, bulk-write) into the taxonomy with `db` / `collection` /
`op` context. This is **on by default** — set `wrapMongoErrors: false` to surface
raw driver errors instead. `statusCode` is refined per code: `NOT_FOUND` → 404,
`DUPLICATE_KEY` / `VERSION_CONFLICT` / `COLLECTION_EXISTS` / `SCHEMA_DRIFT` → 409,
`VALIDATION_FAILED` → 422, `MONGO_TIMEOUT` → 504.

`isDomainError(err)` / `isInfraError(err)` / `isMappedMongoError(err)` are
exported type guards for HTTP layers, and every `AppError` exposes a stable
`toJSON()`. To forward an error to a client without any parsing, use the
`serializeError(err, ctx?)` one-liner (it maps raw driver errors first):

```ts
import { serializeError } from '@ignex/ninox';

app.use((err, _req, res, _next) => {
  const payload = serializeError(err, { db: 'app', collection: 'users' });
  res.status(payload.statusCode).json(payload); // { name, code, message, statusCode, extra? }
});
```

The `ERROR_HTTP_STATUS` table and `httpStatusForError(err)` are also exported if
you need the code → status mapping yourself.

> 💡 **Write-retry safety:** writes are **not** auto-retried by default
> (at-least-once); opt in per op with `retryWrites: true`. Reads always retry
> transient errors.

Schema validation is enforced **by MongoDB** — the DB `$jsonSchema` validator
derived from your schema is installed with `createSchema` (and hot-swapped with
`updateSchema`), and the DB rejects violating writes with `VALIDATION_FAILED`.
ninox deliberately does **not** validate *incoming user input* at runtime (no
client-side/zod layer).

- **Strict by default** — `additionalProperties: false` is emitted unless a
  field opts out (`s.object({ ... }, { additionalProperties: true })`), so
  unknown keys are rejected server-side and the DB validator is the complete
  enforcement point.
- **ORM-reserved fields** — `_id`, the optimistic-lock `__v`, and the soft-delete
  `deletedAt` (active = absent or `null`) are reserved in the validator, so
  `updateWithVersion` / `softDeleteOne` keep working under strict validation
  without declaring those fields.
- **Compile-time safety** — `InferDoc` types catch shape errors at build time;
  the DB validator is the runtime backstop.
- **Rich `$jsonSchema` keywords** — the DSL emits `minLength` / `maxLength` /
  `pattern` (regex), `minimum` / `maximum` / `multipleOf` / `exclusiveMinimum` /
  `exclusiveMaximum`, `minItems` / `maxItems` / `uniqueItems`, `minProperties` /
  `maxProperties`, strict `additionalProperties`, and distinct BSON kinds for
  `s.double()` / `s.long()` / `s.decimal()` (Decimal128). For anything the DSL
  doesn't model (e.g. `patternProperties`, `allOf` / `anyOf` / `oneOf` / `not`,
  `dependencies`), embed a raw fragment with `s.jsonSchema({ ... })` — it is
  passed through verbatim.
- **Validation error detail** — when `wrapMongoErrors` is on, a `VALIDATION_FAILED`
  `DomainError` carries the offending field paths (`extra.fields`), the failing
  document id (`extra.documentId`), and the raw `extra.details`, so a rejected
  write names exactly what (and which document) violated the schema.
- **Index lifecycle** — `createSchema` installs the declared indexes;
  `syncIndexes(collection)` reconciles drift (`await db.syncIndexes('products')`
  creates missing declared keys and drops undeclared ones, `_id_` kept).

### Schema drift (read-time detection)

A document can end up *in* MongoDB without matching its schema — written by an
older app version, another service, the raw driver with validation bypassed, or
left behind by a tightened `updateSchema`. Reads return these docs verbatim
(they were stored before the validator), so drift is invisible unless you look.

ninox can detect drift on read. On every **DB fetch** (cache-miss — cache hits
trust the already-validated stored value), freshly-read documents are checked
against the declared schema and reported per `MongoServiceConfig.drift`:

| mode | behavior |
| --- | --- |
| `'report'` (default) | log a warning naming the offending field paths, return the doc as-is |
| `'throw'` | throw `DomainError SCHEMA_DRIFT` (with `extra.issues`); the drifted doc is **never cached or returned** |
| `'off'` | no drift checking (pre-1.x behavior) |

```ts
createMongoService(clients, { drift: 'throw' }); // fail closed on drift
```

Detection is **read-only** — documents are never mutated or repaired. It covers
`getOne` / `getOneOrFail` / `findMany` / `findActive*`, the query builder, and
`paginateFlexible` / `paginateCursor`. Projected (`select`) reads are skipped
(partial documents would false-positive on excluded required fields). Override
per op with `QueryOptions.drift` (`true` → `'throw'`, `false` → `'off'`):

```ts
await users.getOne('users', { email }, { drift: true }); // throw on drift for this read
```

This pairs with the DB validator: the server rejects violating *writes*, and the
drift layer surfaces violating *stored* documents so they can't silently corrupt
reads.

> ⚠️ **Drift checking costs CPU per fetch.** `'report'` (the default) walks the
> full document tree against the schema on every DB fetch (cache-misses only —
> cache hits skip it). For very high-QPS read paths that don't need it, set
> `drift: 'off'` service-wide or per op (`{ drift: false }`).

## Hooks

Per-collection lifecycle middleware, declared on `defineCollection(..., { hooks })`:

```ts
const users = defineCollection('users', userSchema, {
  hooks: {
    beforeCreate: (ctx) => audit(`create ${ctx.doc?.email}`),
    afterCreate: () => invalidateCount(),
    afterRead: (ctx) => maskSensitive(ctx.doc),
  },
});
```

Hook names: `before/afterCreate`, `before/afterUpdate`, `before/afterDelete`,
`afterRead`. `runHooks` and `HOOK_NAMES` are exported for manual dispatch.
`afterRead` fires on **every** read — cache hit or miss — and receives a fresh
per-caller clone, so a mutating hook can't poison the shared cache entry.
`before/after` create/update/delete hooks fire on actual ninox writes (which
invalidate that collection's cache).

## Logging & configuration

`MongoServiceConfig` beyond the defaults:

```ts
createMongoService(clients, {
  appName: 'orders-api',      // Mongo client appName
  logger,                     // pino-like: debug/info/warn/error
  wrapMongoErrors: true,      // map driver errors to the taxonomy
  migrationDir: './migrations', // default for createMongoMigrationRunner
  cache: { maxSize: 1000, ttlMs: 30_000, clone: true }, // configure the default cache
  cacheWatch: true,           // change-stream invalidation of the cache (replica sets)
  drift: 'report',            // read-time schema-drift detection ('report'|'throw'|'off')
  dedupeReads: true,
  perf: true,                 // master switch for cache + dedup
});
```

## Operations: health & multi-DB

- `service.health()` — ping every connected DB and report `{ ok, latencyMs, dbs }`.
- **Multi-DB services** — define several clients in one service; each gets its own
  typed manager (`service.db.primaryClient`, `service.db.auditClient`, …), one
  connection pool per URL, and **cache/dedup keys are namespaced by database** so
  same-named collections in different databases never collide.
- `watchCollection` / repository `.watch()` — caller-owned change streams.
- `eachDb(fn)` — run a function over every connected manager.

```ts
const service = createMongoService({
  primary: { name: 'app',  dbUrl: MONGO_URL, collections },
  audit:  { name: 'audit', dbUrl: MONGO_URL, collections: auditCollections },
}, { logger });
await service.makeConnections();

const report = await service.health();              // per-DB ping results
await service.db.auditClient.insertOne('events', { type: 'login', at: new Date() });

const stream = service.db.primaryClient.watchCollection('users'); // caller-owned change stream
for await (const change of stream) { /* react to changes */ }
```

## Utilities

Re-exported helpers for app code (also via `@ignex/ninox/utils`):

- `withRetry(fn, { maxAttempts, delayMs })` — transient-error retry with backoff.
- `withTransaction(client, fn(session))` — manual session transaction helper.
- `withTimeout(promise, ms, label)` / `sleep(ms)` — async timeouts.
- `LRU` / `createCachedFactory` / `createCachedAsyncFactory` — caches (the async
  factory dedupes in-flight calls and **never caches failures**).
- `stableHash` / `stableStringify` — deterministic, order-insensitive hashing.
- `cloneDeep` — deep clone preserving `Date` / `ObjectId` / `RegExp`.
- `createConsoleLogger` / `createNoopLogger` — structured loggers.

## Schema introspection

`toMongoValidator(schema)` returns the `{ $jsonSchema }` validator ninox installs
via `createSchema`; `toMongoSchema(schema)` returns the bare `$jsonSchema` if you
need it directly (e.g. in your own provisioning tooling).

## Service ↔ repository naming

The service layer (op-based) and the optional repository layer cover the same
concepts with slightly different names. `createRepository(manager, 'users')` binds
a manager + collection, so `repo` methods are collection-free:

| Concept | Service (`db.*`) | Repository (`repo.*`) |
| --- | --- | --- |
| fetch one by id | `getOne('users', { _id })` | `getById(id)` |
| fetch one by filter | `getOne` / `getOneOrFail` | `findOne` / `findOneOrFail` |
| fetch many | `findMany` | `findMany` |
| insert | `insertOne` / `insertMany` | `create` / `createMany` |
| update | `updateOne('users', { _id }, …)` | `update(id, …)` |
| optimistic lock | `updateWithVersion` | `updateVersioned` |
| delete | `deleteOne('users', { _id }, …)` | `deleteById(id)` |
| soft delete | `softDeleteOne` | `softDelete` |
| count | `countDocuments` | `count` |
| distinct | `distinct` | `distinct` |
| `$facet` paginate | `paginateFlexible` | `page` |
| keyset paginate | `paginateCursor` | `pageCursor` |
| change stream | `watchCollection` | `watch` |
| aggregation | `pipeline` / `aggregate` | `pipeline` / `aggregate` |
| populate | `populate` | `populate` |

## API reference

[`API.md`](./API.md) enumerates every public export with signatures and links to
examples.

## Examples

Runnable, live-Mongo examples live in [`examples/`](./examples) — CRUD, query
builder, pagination, typed relations, cache+dedup defaults, the global HotCache
(replica change-stream watch / standalone ticker), `cacheWatch` (change-stream
invalidation of the shared query cache), transactions, aggregation, migrations,
and a perf-by-default comparison. Run any of them with
`bun run examples/<file>.ts` (see [`examples/README.md`](./examples/README.md)).

## Performance

| scenario | naive | optimized |
| --- | --- | --- |
| populate 100 orders | 17,000 queries (N+1) | **340 queries** (~50× fewer round trips) |
| paginate | count + find (2 round trips) | `$facet` **1 round trip** |
| cache hit | 1 driver call | **0 driver calls** |
| 50 concurrent identical reads | 50 server queries, 17 ms | **1 server query**, 1.5 ms |

Run the full harness (requires local MongoDB, see `.env`):

```bash
bun run bench     # → bench/results/summary.json
```

## Production considerations

**Multi-DB cache isolation.** A single service can define several DB clients; the
query cache and in-flight dedup are shared across them, and their keys are
namespaced by **database** — so same-named physical collections in different
databases can never share (or coalesce) entries. No action needed; it's handled.

**Standalone HotCache freshness is opt-in per query.** In standalone mode the
ticker only refreshes queries that set `refreshIntervalMs`. A query with neither
`refreshIntervalMs` nor `ttlMs` is served until manually invalidated (unbounded
staleness); `start()` logs a warning naming those queries. This is deliberate —
a default background poll of every query would add DB load. For bounded
freshness set `refreshIntervalMs` (or `ttlMs`, or wire `invalidateCollection`),
or set `autoRefresh: false` to disable the ticker entirely.

**`cacheWatch` needs a replica set / mongos.** Change-stream invalidation of the
shared query cache is opt-in and requires change streams. On a standalone server
the watchers are rejected, a warning is logged once, and invalidation silently
disables (the cache stays write-through only) — set `cache: { ttlMs }` there.

**Update payloads are precise.** `updateOne` / `updateMany` / `upsert` / … reject
unknown keys in object literals AND non-literal patches. The only way an unknown
key passes is a variable explicitly typed with an index signature
(`Record<string, any>`) — prefer inline literals for full checking.

**Index drift.** `createSchema` installs declared indexes; if they drift out of
band (manual drops, other tooling), `syncIndexes('collection')` reconciles —
creates missing declared indexes and drops undeclared ones (`_id_` kept).

**Observability.** `QueryCache.stats()` (hits/misses/evictions/…) and
`hot.stats()` (per-query hits/misses/refreshes/loadErrors/evictions/…) give you
the cache-effectiveness signals to watch in production.

**Graceful shutdown.** `closeConnections()` closes the pool and tears down any
`cacheWatch` change streams. The HotCache is standalone and user-managed — call
`hot.stop()` on shutdown.

## Tests

```bash
bun test          # unit + integration (integration skips when no Mongo is reachable)
```

## Development

```bash
bun run typecheck     # tsc --noEmit (includes the type-assertion suite)
bun run lint          # Biome check (format + lint)
bun run lint:fix      # apply Biome safe fixes
bun test              # unit + integration
bun test --coverage   # coverage report (≥ 85% lines enforced in CI)
bun run build         # tsup → dist/ (ESM + .d.ts)
npm pack --dry-run    # inspect the published tarball contents
```

## Publishing

`ninox` is published from the built `dist/` (ESM + type declarations).
The `files` allowlist ships `dist/`, `LICENSE`, and `README.md` — no `src/`,
tests, or examples. CI enforces typecheck, lint, dependency audit, coverage
(≥ 85%), the full example suite, a replica-set job for the HotCache
change-stream tests, and an `npm pack` → fresh Node consumer smoke test.

Release notes are kept in [`CHANGELOG.md`](./CHANGELOG.md). The publish gate
(`prepublishOnly`) runs typecheck + lint + build.

### Support matrix

| runtime | minimum |
| --- | --- |
| Node.js | ≥ 18.17 (ESM) |
| Bun | ≥ 1.0 |
| TypeScript | ≥ 5.5 (peer, optional — pure JS works too) |
| MongoDB driver | `mongodb` ^7 (only runtime dependency) |
| MongoDB server | 4.4+ core; 5.1+ for `$fill` / `$densify`; **replica set / mongos** for transactions, change streams, and `cacheWatch` |

```bash
bun run build
npm publish          # after bumping the version (semver)
```

## License

MIT — see [`LICENSE`](./LICENSE).

## Package layout

See [`STRUCTURE.md`](./STRUCTURE.md) for the full layer map.

