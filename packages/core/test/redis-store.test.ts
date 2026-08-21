/**
 * `createRedisStore` — Redis-backed Store driver (ioredis adapter).
 *
 * The driver lazy-imports ioredis (optional dependency), so without it the
 * client factory throws `redisMissingError`. These tests inject a fake
 * ioredis client to verify the Store contract (get/set/delete/touch/close),
 * TTL mapping, JSON round-tripping, and key namespacing — no real Redis
 * needed.
 */

import { createRedisStore, redisMissingError } from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

/** A fake ioredis client recording calls into an in-memory map. */
function fakeRedis() {
  const data = new Map<string, { value: string; px?: number }>();
  const client = {
    get: vi.fn(async (k: string) => data.get(k)?.value ?? null),
    set: vi.fn(async (k: string, v: string, mode?: "PX", ms?: number) => {
      data.set(k, { value: v, px: mode === "PX" ? ms : undefined });
      return "OK";
    }),
    del: vi.fn(async (...ks: string[]) => {
      let n = 0;
      for (const k of ks) if (data.delete(k)) n += 1;
      return n;
    }),
    pexpire: vi.fn(async (k: string, ms: number) => {
      const e = data.get(k);
      if (!e) return 0;
      e.px = ms;
      return 1;
    }),
    persist: vi.fn(async (k: string) => {
      const e = data.get(k);
      if (!e) return 0;
      e.px = undefined;
      return 1;
    }),
    quit: vi.fn(async () => "OK"),
  };
  return { client, data };
}

const makeStore = (client: unknown) =>
  createRedisStore({
    // options.client is a CONSTRUCTOR yielding the fake instance (use a
    // function constructor — returning a value from `new` is not allowed).
    client: function RedisFake() {
      return client;
    } as never,
    prefix: "test",
  });

describe("createRedisStore", () => {
  it("throws a descriptive error when ioredis is missing", async () => {
    const store = createRedisStore({});
    // No injected client + no ioredis installed → the lazy import fails.
    await expect(store.set("k", "v")).rejects.toThrow(/ioredis is not installed/);
    expect(redisMissingError().message).toContain("bun add ioredis");
  });

  it("set/get round-trips JSON values under the namespace", async () => {
    const { client, data } = fakeRedis();
    const store = makeStore(client);
    await store.set("user:1", { name: "a", age: 2 });
    const value = await store.get("user:1");
    expect(value).toEqual({ name: "a", age: 2 });
    // Keys are namespaced: `test:user:1`.
    expect(data.has("test:user:1")).toBe(true);
    expect(client.set).toHaveBeenCalledWith("test:user:1", JSON.stringify({ name: "a", age: 2 }));
  });

  it("set with ttlMs maps to SET PX with the remaining ms", async () => {
    const { client, data } = fakeRedis();
    const store = makeStore(client);
    const before = Date.now();
    await store.set("k", "v", { ttlMs: 60_000 });
    const entry = data.get("test:k");
    expect(entry?.px).toBeGreaterThanOrEqual(59_000);
    expect(entry?.px).toBeLessThanOrEqual(60_000);
    expect(client.set).toHaveBeenCalled();
    void before;
  });

  it("set with expiresAt maps to SET PX (wall-clock)", async () => {
    const { client, data } = fakeRedis();
    const store = makeStore(client);
    const expiresAt = Date.now() + 30_000;
    await store.set("k", "v", { expiresAt });
    const entry = data.get("test:k");
    expect(entry?.px).toBeGreaterThan(0);
    expect(entry?.px).toBeLessThanOrEqual(30_000);
  });

  it("delete removes the key (no-op when absent)", async () => {
    const { client, data } = fakeRedis();
    const store = makeStore(client);
    await store.set("k", "v");
    await store.delete("k");
    expect(data.has("test:k")).toBe(false);
    expect(await store.get("k")).toBeNull();
  });

  it("touch re-applies a TTL (PEXPIRE) and persist clears it", async () => {
    const { client, data } = fakeRedis();
    const store = makeStore(client);
    await store.set("k", "v", { ttlMs: 10_000 });
    await store.touch("k", { ttlMs: 120_000 });
    expect(data.get("test:k")?.px).toBeGreaterThanOrEqual(119_000);
    await store.touch("k"); // no TTL → PERSIST (never expires)
    expect(data.get("test:k")?.px).toBeUndefined();
    expect(client.persist).toHaveBeenCalledWith("test:k");
  });

  it("close() quits the client", async () => {
    const { client } = fakeRedis();
    const store = makeStore(client);
    await store.set("k", "v");
    await store.close();
    expect(client.quit).toHaveBeenCalled();
  });

  it("get returns the raw string when the value is not JSON", async () => {
    const { client, data } = fakeRedis();
    data.set("test:k", { value: "not-json{" });
    const store = makeStore(client);
    expect(await store.get("k")).toBe("not-json{");
  });
});
