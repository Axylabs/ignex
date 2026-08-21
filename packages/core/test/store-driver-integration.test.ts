/**
 * Driver override integration tests — the "bring your own driver" story.
 *
 * Proves that a user-supplied `Store` (here a wrapped `createMemoryStore` with
 * an observable wrapper) flows into the built-in consumers: the rate-limit
 * plugin's state store, the HTTP response cache's backing store, and the
 * durable job store — exactly like Laravel's `Cache::extend`/`Session::driver`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createApp,
  createContext,
  createFileJobStore,
  createMemoryStore,
  createSessionManager,
  createSessionStoreFromStore,
  HttpResponseCache,
  rateLimit,
  type Store,
} from "../src/index.js";

const req = (url: string) => new Request(`http://x${url}`);

/** Wrap a store and count every read/write — proves the custom driver is used. */
const instrumented = (
  inner: Store,
): { store: Store; reads: () => number; writes: () => number } => {
  let reads = 0;
  let writes = 0;
  return {
    reads: () => reads,
    writes: () => writes,
    store: {
      get(key) {
        reads += 1;
        return inner.get(key);
      },
      set(key, value, opts) {
        writes += 1;
        inner.set(key, value, opts);
      },
      delete(key) {
        inner.delete(key);
      },
      touch(key, opts) {
        inner.touch?.(key, opts);
      },
      close() {
        inner.close?.();
      },
    },
  };
};

describe("rateLimit with a custom store", () => {
  it("uses the custom store and still enforces the window", async () => {
    const { store, reads, writes } = instrumented(createMemoryStore());
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1, store })],
      handler: () => new Response("ok"),
    });

    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(429);
    expect(reads()).toBeGreaterThan(0);
    expect(writes()).toBeGreaterThan(0);
  });
});

describe("HttpResponseCache with a custom backing store", () => {
  it("stores and serves hits through the custom store", async () => {
    const { store, reads, writes } = instrumented(createMemoryStore());
    const cache = new HttpResponseCache({ store: store as never });
    let calls = 0;

    const first = await cache.getOrSet(req("/a"), async () => {
      calls += 1;
      return new Response("hello", { headers: { "content-type": "text/plain" } });
    });
    expect(first.status).toBe(200);
    expect(await first.text()).toBe("hello");

    const second = await cache.getOrSet(req("/a"), async () => {
      calls += 1;
      return new Response("hello2");
    });
    expect(await second.text()).toBe("hello");
    expect(calls).toBe(1);
    expect(reads()).toBeGreaterThan(0);
    expect(writes()).toBeGreaterThan(0);
  });
});

describe("sessions with a custom store", () => {
  it("writes session data through the custom store via the adapter", async () => {
    const { store, writes } = instrumented(createMemoryStore());
    const manager = createSessionManager({
      secret: "test-secret-key-1234567890",
      // `createSessionStoreFromStore` is the documented bridge: wrap ANY Store
      // driver as a SessionStore (adds copy semantics + async contract).
      store: createSessionStoreFromStore(store),
    });

    const ctx = createContext(new Request("http://localhost:3000/"), {});
    const session = await manager.loadOrCreate(ctx);
    session.data.user = "ada";
    await session.save();

    expect(writes()).toBeGreaterThan(0);
    // The value actually landed in the backing store.
    expect(await store.get(session.id)).toEqual({ user: "ada" });
  });
});

describe("durable jobs with a file store driver", () => {
  it("createFileJobStore persists through the generic file driver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-job-driver-"));
    const store = createFileJobStore(dir);
    const now = Date.now();

    await store.enqueue({
      id: "job-driver-1",
      name: "x",
      runAt: now - 1000,
      attempts: 0,
      maxAttempts: 1,
      status: "queued",
      createdAt: now,
    });

    const reloaded = createFileJobStore(dir);
    expect(await reloaded.list()).toHaveLength(1);
    expect((await reloaded.list())[0]?.name).toBe("x");
  });
});
