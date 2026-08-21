# Store Drivers (Laravel-style)

A **driver** is a named implementation of a fixed contract. ignex's storage
layer follows the Laravel model: one `Store` contract, many backends, and a
manager that resolves them by name — so you can swap storage without touching
your code, and plug in your own backend with one line.

## The `Store` contract

`data/store/types.ts` defines the generic key-value store every driver
implements:

```ts
interface Store {
  get(key: string): MaybePromise<unknown | null>;
  set(key: string, value: unknown, options?: StoreSetOptions): MaybePromise<void>;
  delete(key: string): MaybePromise<void>;
  touch?(key: string, options?: StoreSetOptions): MaybePromise<void>;
  close?(): MaybePromise<void>;
}
```

`StoreSetOptions` carries a relative `ttlMs` or an absolute `expiresAt`.
Methods are **sync-capable** (`MaybePromise`): the memory/file/sqlite drivers
are fully synchronous after construction — zero Promise/microtask on the hot
path — while custom async drivers (Redis, …) return Promises. `await` works
either way; hot paths branch on `instanceof Promise` like the rest of ignex.

## Built-in drivers

| Driver    | Backend                            | Sync ops | Notes                                    |
| --------- | ---------------------------------- | -------- | ---------------------------------------- |
| `memory`  | `Map` + lazy expiry + unref'd sweep | yes      | Hot-path default; `close()` clears sweep |
| `sqlite`  | `bun:sqlite` `kv` table            | yes      | Async **factory** (module bootstrap); returns `null` when unavailable |
| `file`    | JSON-lines file, atomic tmp+rename | yes      | Portable `node:fs`; survives restarts    |

Create them directly, or through the manager:

```ts
import { createMemoryStore, createSqliteStore, createFileStore } from "@ignex/core";

const memory = createMemoryStore();                              // no expiry
const ttl = createMemoryStore({ ttlMs: 60_000 });                // 60s default
const sqlite = await createSqliteStore(":memory:");              // or a file path
const file = createFileStore(".ignex/stores");                   // store.jsonl
```

## The manager: `createStoreManager`

Resolves drivers by name, memoizing one instance per name:

```ts
import { createStoreManager } from "@ignex/core";

const stores = createStoreManager({ default: "memory" });

const cache = stores.driver();          // → the memoized memory store
const durable = stores.driver("file");  // → the memoized file store
```

Built-ins are pre-registered: `memory` (default), `sqlite` (`:memory:` with a
memory fallback when `bun:sqlite` is unavailable), and `file`
(`<cwd>/.ignex/stores`).

## Custom drivers (`extend`)

Register your own backend — the Laravel `Cache::extend` story:

```ts
import { createStoreManager } from "@ignex/core";

const stores = createStoreManager();
stores.extend("redis", () => createRedisStore(process.env.REDIS_URL));

const shared = stores.driver("redis");
```

`extend` replaces an existing name too, so you can override a built-in:

```ts
stores.extend("memory", () => createSharedMemoryStore());  // now shared process-wide
```

The generic primitive behind it — `createDriverManager` — works for any
driver type, not just stores:

```ts
import { createDriverManager } from "@ignex/core";

const backends = createDriverManager<MyBackend>({ default: "a", drivers: { a, b } });
```

## Where ignex uses drivers

| Feature          | Contract                 | How to override                                              |
| ---------------- | ------------------------ | ------------------------------------------------------------ |
| Sessions         | `SessionStore`           | `createSessionStoreFromStore(store)` wraps any `Store`; pass to `createSessionManager` / the `session()` plugin |
| Durable jobs     | `JobStore`               | `createStoreJobStore(store)` wraps any `Store`; or `createFileJobStore` / `createSqliteJobStore` |
| HTTP response cache | `HttpResponseCacheStore` | `new HttpResponseCache({ store })` — any store implementing `get(key, {allowStale})` / `set(key, value, {ttlMs, staleTtlMs})` |
| Rate limiting    | `RateLimitStore`         | `rateLimit({ store })` — share limits across processes via a shared backend |

### Sessions

```ts
import {
  createSessionManager,
  createSessionStoreFromStore,
  createSqliteStore,
} from "@ignex/core";

const sqlite = await createSqliteStore("data/sessions.db");
const session = createSessionManager({
  secret: process.env.SESSION_SECRET,
  store: createSessionStoreFromStore(sqlite),   // any Store → SessionStore
});
```

The store adapters (`createSessionStoreFromStore`) add session semantics on top
of the generic contract: values are copied on read/write, `expiresAt` is an
absolute deadline, and `close()` releases the backing driver's resources.

### Durable jobs

```ts
import { createDurableJobQueue, createStoreJobStore, createFileStore } from "@ignex/core";

const queue = createDurableJobQueue({
  store: createStoreJobStore(createFileStore("data/jobs")),
  handlers: { "send-email": async (payload) => { /* … */ } },
});
```

`createStoreJobStore` keeps the whole job map in memory and persists it under a
reserved key on every mutation — matching the file/SQLite stores' semantics, so
any driver (including a custom Redis store) can back the durable queue. The
initial read must be synchronous; pre-warm async drivers before passing them in.

### HTTP response cache

```ts
import { HttpResponseCache, createMemoryStore } from "@ignex/core";

const cache = new HttpResponseCache({
  store: /* any HttpResponseCacheStore — default is an LRU */,
});
```

### Rate limiting

```ts
import { rateLimit } from "@ignex/core";

const app = createApp({
  plugins: [rateLimit({ maxRequests: 100, store: sharedStore })],
  // …
});
```

A custom `store` routes the per-key window state through your backend, so
limits stick across processes (e.g. multiple Bun instances behind a proxy).
The default is an in-process LRU — the sync hot path is unchanged.

## Conventions

- **One contract, many drivers.** Implementations live in
  `packages/core/src/data/store/` (generic `Store`) or beside their feature
  (`security/session-store.ts`, `platform/jobs-store.ts`).
- **Sync-capable by default.** The built-in drivers are synchronous after
  construction; only the sqlite *factory* is async (`bun:sqlite` bootstrap).
- **`close()` releases resources.** Memory sweep timers, sqlite handles — wire
  the store's `close()` into your app's shutdown (session plugin does this
  automatically via `hookToPlugin`).
- **`null` means "backend unavailable".** `createSqliteStore`/… return `null`
  when the module is missing; callers fall back (the manager's `sqlite` driver
  falls back to `memory`).
- See [adding-a-feature.md](adding-a-feature.md) § "Add a store driver" for the
  checklist when adding a new driver.
