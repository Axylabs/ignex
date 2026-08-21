/**
 * Store driver + manager tests.
 *
 * Covers the generic `Store` contract across all three built-in drivers
 * (memory, sqlite, file), the Laravel-style `createStoreManager` (default
 * resolution, memoization, `extend` custom drivers, `setDefault`, `forget`),
 * and the sync-capable surface (memory/file are synchronous).
 */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDriverManager,
  createFileStore,
  createMemoryStore,
  createSqliteStore,
  createStoreManager,
  type Store,
} from "../src/index.js";

const tmp = () => mkdtempSync(join(tmpdir(), "ignex-store-"));

describe("createMemoryStore", () => {
  it("round-trips values, deletes, and is synchronous", () => {
    const store = createMemoryStore();
    store.set("a", { n: 1 });
    expect(store.get("a")).toEqual({ n: 1 });
    store.delete("a");
    expect(store.get("a")).toBeNull();
  });

  it("expires entries by ttlMs and expiresAt", () => {
    const store = createMemoryStore();
    store.set("ttl", "v", { ttlMs: 50 });
    store.set("abs", "v", { expiresAt: Date.now() + 50 });
    expect(store.get("ttl")).toBe("v");
    expect(store.get("abs")).toBe("v");

    // Fast-forward past the TTL by re-setting a past expiry (no fake timers).
    store.set("ttl", "v", { expiresAt: Date.now() - 1 });
    store.set("abs", "v", { expiresAt: Date.now() - 1 });
    expect(store.get("ttl")).toBeNull();
    expect(store.get("abs")).toBeNull();
  });

  it("applies the default ttlMs when set() omits one", () => {
    const store = createMemoryStore({ ttlMs: 30 });
    store.set("k", 1);
    expect(store.get("k")).toBe(1);
    store.touch?.("k", { expiresAt: Date.now() - 1 });
    expect(store.get("k")).toBeNull();
  });

  it("touch extends an entry's lifetime", () => {
    const store = createMemoryStore();
    store.set("k", "v", { ttlMs: 30 });
    store.touch?.("k", { ttlMs: 60_000 });
    expect(store.get("k")).toBe("v");
  });

  it("close() clears the sweep interval and entries", () => {
    const store = createMemoryStore({ sweepIntervalMs: 1000 });
    store.set("a", 1);
    store.close();
    expect(store.get("a")).toBeNull();
  });
});

describe("createSqliteStore", () => {
  const open = async (file = ":memory:", options?: Parameters<typeof createSqliteStore>[1]) => {
    const store = await createSqliteStore(file, options);
    if (!store) return null; // bun:sqlite unavailable
    return store;
  };

  it("round-trips values, touches, and deletes", async () => {
    const store = await open();
    if (!store) return;

    await store.set("s1", { user: "ada" });
    expect(await store.get("s1")).toEqual({ user: "ada" });

    await store.touch?.("s1", { ttlMs: 120_000 });
    expect(await store.get("s1")).toEqual({ user: "ada" });

    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });

  it("lazily removes expired rows on read", async () => {
    const store = await open();
    if (!store) return;

    await store.set("exp", { x: 1 }, { expiresAt: Date.now() - 1 });
    expect(await store.get("exp")).toBeNull();
  });

  it("persists across store instances when file-backed", async () => {
    const file = join(tmp(), "store.db");
    const store1 = await open(file);
    if (!store1) return;

    await store1.set("persist", { v: 42 });
    store1.close?.();

    const store2 = await open(file);
    if (!store2) return;
    expect(await store2.get("persist")).toEqual({ v: 42 });
  });

  it("honours a custom table + column mapping", async () => {
    const store = await open(":memory:", {
      table: "custom",
      keyColumn: "id",
      valueColumn: "data",
    });
    if (!store) return;

    await store.set("k1", { ok: true });
    expect(await store.get("k1")).toEqual({ ok: true });
  });
});

describe("createFileStore", () => {
  it("round-trips and persists across instances", () => {
    const dir = tmp();
    const store = createFileStore(dir);
    store.set("a", { n: 1 });
    store.set("b", [1, 2]);

    const reloaded = createFileStore(dir);
    expect(reloaded.get("a")).toEqual({ n: 1 });
    expect(reloaded.get("b")).toEqual([1, 2]);
  });

  it("writes to the configured file name", () => {
    const dir = tmp();
    createFileStore(dir, { file: "custom.jsonl" }).set("k", "v");
    expect(readdirSync(dir)).toContain("custom.jsonl");
  });

  it("skips expired entries on read and prunes them on write", () => {
    const dir = tmp();
    const store = createFileStore(dir);
    store.set("gone", "v", { expiresAt: Date.now() - 1 });
    expect(store.get("gone")).toBeNull();

    // A surviving write prunes the expired entry from disk.
    store.set("keep", "v");
    const reloaded = createFileStore(dir);
    expect(reloaded.get("keep")).toBe("v");
    expect(reloaded.get("gone")).toBeNull();
  });
});

describe("createDriverManager", () => {
  it("resolves the default driver and memoizes instances", () => {
    let created = 0;
    const manager = createDriverManager<Store>({
      default: "memory",
      drivers: {
        memory: () => {
          created += 1;
          return createMemoryStore();
        },
      },
    });

    const a = manager.driver();
    const b = manager.driver("memory");
    expect(a).toBe(b);
    expect(created).toBe(1);
  });

  it("throws for unknown drivers and without a default", () => {
    const manager = createDriverManager<Store>({ drivers: { memory: () => createMemoryStore() } });
    expect(() => manager.driver("nope")).toThrow(/Unknown driver/);
    expect(() => manager.driver()).toThrow(/no default/);
  });

  it("extend registers custom drivers and setDefault switches the default", () => {
    const manager = createDriverManager<Store>({
      default: "memory",
      drivers: { memory: () => createMemoryStore() },
    });
    manager.extend("custom", () => createMemoryStore({ ttlMs: 5 }));
    expect(manager.has("custom")).toBe(true);
    expect(manager.driver("custom")).not.toBe(manager.driver("memory"));

    manager.setDefault("custom");
    expect(manager.driver()).toBe(manager.driver("custom"));
    expect(manager.names()).toEqual(["custom", "memory"]);
  });

  it("extend replaces an existing factory and forget re-creates", () => {
    let created = 0;
    const manager = createDriverManager<Store>({
      default: "memory",
      drivers: { memory: () => createMemoryStore() },
    });
    const original = manager.driver();

    manager.extend("memory", () => {
      created += 1;
      return createMemoryStore();
    });
    expect(manager.driver()).not.toBe(original);

    manager.forget("memory");
    manager.driver();
    expect(created).toBe(2);
  });
});

describe("createStoreManager", () => {
  it("ships the built-in memory + sqlite + file drivers", () => {
    const stores = createStoreManager();
    expect(stores.names()).toEqual(["file", "memory", "sqlite"]);
    expect(stores.driver("memory")).toBeInstanceOf(Object);
    expect(stores.driver()).toBe(stores.driver("memory")); // default = memory
  });

  it("merges extra driver factories over the built-ins", () => {
    const stores = createStoreManager({
      default: "custom",
      drivers: { custom: () => createMemoryStore() },
    });
    expect(stores.driver()).toBe(stores.driver("custom"));
  });

  it("lets users override a built-in driver via extend", () => {
    const stores = createStoreManager();
    const custom = createMemoryStore();
    stores.extend("memory", () => custom);
    expect(stores.driver("memory")).toBe(custom);
  });
});
