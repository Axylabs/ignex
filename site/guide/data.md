# Data: stores, cache, batching, jobs

ignex's data layer is a handful of small, composable primitives —
Laravel-style store drivers, response caching, request batching, and job
queues — with no ORM of its own (SQL means [Drizzle](https://orm.drizzle.team),
via `ignex resource`).

## Stores: one contract, many backends

Every storage backend implements the same tiny `Store` contract
(`get` / `set` / `delete` / atomic `update`), and a manager resolves them by
name — swap storage without touching your code:

```ts
import { createMemoryStore, createSqliteStore, createStoreManager } from "@ignex/core";

const stores = createStoreManager({ default: "memory" });

const cache = stores.driver(); // memoized memory store
const durable = stores.driver("file"); // memoized file store
```

| Driver | Backend | Sync ops | Survives restarts |
| --- | --- | --- | --- |
| `memory` | `Map` + lazy expiry | yes | no — the hot-path default |
| `sqlite` | `bun:sqlite` | yes | yes |
| `file` | JSON-lines, atomic tmp+rename | yes | yes |
| `redis` | Redis hashes + TTL | no | yes — add with `extend` |

Register your own backend with one line (the Laravel `Cache::extend`
story):

```ts
import { createRedisStore, createStoreManager } from "@ignex/core";

const stores = createStoreManager();
stores.extend("redis", () => createRedisStore({ url: process.env.REDIS_URL }));

const shared = stores.driver("redis");
```

The built-in drivers are **sync-capable** — after construction, memory/
file/sqlite reads and writes cost zero Promises on the hot path. `await`
works either way.

### Where ignex plugs stores in

| Feature | How to override |
| --- | --- |
| Sessions | `session({ store: createSessionStoreFromStore(store) })` |
| Durable jobs | `createDurableJobQueue({ store: createStoreJobStore(store) })` |
| HTTP response cache | `new HttpResponseCache({ store })` |
| Rate limiting | `rateLimit({ maxRequests: 100, store })` — shared across processes |

## Response caching

```ts
import { get } from "@ignex/core/http";
import { withBrowserCache } from "@ignex/core";

export default get(() => withBrowserCache(ctx.json({ cached: true }), { maxAge: 10 }));
```

Lower-level pieces: `cacheControl`, `HttpResponseCache` (stale-while-
revalidate over any store), `etagWithEncoding`, and conditional-request
helpers.

## Batching high-volume reads (DataLoader)

`ctx.loader(...)` gives request-scoped deduplication. For a shared data
source, create an adaptive loader once at application scope — it grows
batches when they're fast and halves the limit when latency slips:

```ts
import { createDataLoader } from "@ignex/core";

const users = createDataLoader(
  async (ids: readonly number[]) => userRepository.findMany(ids),
  {
    adaptive: { minBatchSize: 8, maxBatchSize: 512, targetBatchMs: 1 },
    max: 10_000, // bounded cache
  },
);

const user = await users.load(userId);
```

`users.stats` exposes the current limit, latency EWMA, and cache hits.

## Background jobs

In-process queue for fire-and-forget work:

```ts
import { createJobQueue, withRetry, withTimeout } from "@ignex/core";

const queue = createJobQueue({ concurrency: 2 });

const task = withTimeout(5000)(
  withRetry(2)(async () => {
    // do work
  }),
);

queue.enqueue("demo", task);
```

**Durable** jobs — crash-recoverable, claim/lease semantics, retries with
backoff, recurring schedules — use the durable queue over a store:

```ts
import { createDurableJobQueue, createSqliteJobStore } from "@ignex/core";

const queue = createDurableJobQueue({
  store: createSqliteJobStore("data/jobs.db"),
  handlers: {
    "send-email": async (payload) => {
      // ...
    },
  },
});
```

Run the worker in production with `ignex queue:work`; scheduled jobs with
`ignex schedule:run`. Delivery is at-least-once, so handlers must be
idempotent. For **mailer + notifications** (`createMailer`,
`createNotifier` — realtime push with email fallback), see the
[Cookbook](./cookbook#mail-notifications).

## SQL via Drizzle (`ignex resource`)

ignex wraps the standard approach — [Drizzle](https://orm.drizzle.team) —
with the same CLI surface as everything else:

```sh
# SQLite (default): model + CRUD routes + drizzle.config.ts + src/db-sql.ts
ignex resource User --db sql --fields "email:string(format email),age:integer,active:boolean"

# PostgreSQL
ignex resource User --db sql --sql-driver postgres --fields "email:string,active:boolean"

# Versioned migrations
ignex migrate create add-profile --db sql   # drizzle-kit generate
ignex migrate up --db sql                   # drizzle-kit migrate
```

You get: a typed Drizzle table (`src/models/users.ts`), the shared client
(`bun:sqlite` with WAL or `node-postgres`), validated CRUD routes under
`src/routes/api/users/*` with pagination and proper 400/404s, and a
drizzle-kit config. This is intentionally **not** a new ORM — it's Drizzle
with ignex-shaped DX.

## Multi-instance

The default in-process stores break the moment you scale to N processes.
Swap the shared state to Redis:

```ts
import { createPersistentHttpCacheStore, createRedisRateLimitStore, createRedisStore } from "@ignex/core";

export const redis = createRedisStore({ url: process.env.REDIS_URL });
export const redisLimiter = createRedisRateLimitStore({ url: process.env.REDIS_URL });
export const responseCache = createPersistentHttpCacheStore(redis);

// session({ store: … }), rateLimit({ store: redisLimiter }),
// new HttpResponseCache({ store: responseCache })
```

Full topology (including `reusePort` and durable-job workers across
instances) in [Deployment](./deployment).
