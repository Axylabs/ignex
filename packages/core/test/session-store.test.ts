/**
 * Session store tests — the in-memory store and the new SQLite store
 * (`createSqliteSessionStore`, `bun:sqlite` with a `null` fallback).
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemorySessionStore, createSqliteSessionStore } from "../src/index.js";

const openStores: Array<{ close?(): void }> = [];
afterEach(() => {
  for (const store of openStores.splice(0)) store.close?.();
});

const opened = <T extends { close?(): void }>(store: T): T => {
  openStores.push(store);
  return store;
};

describe("createMemorySessionStore", () => {
  it("round-trips data and deletes", async () => {
    const store = opened(createMemorySessionStore());
    await store.set("a", { user: "ada" });
    expect(await store.get("a")).toEqual({ user: "ada" });
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
  });

  it("returns copies so caller mutations never leak", async () => {
    const store = opened(createMemorySessionStore());
    await store.set("a", { n: 1 });
    const data = await store.get("a");
    if (data) data.n = 999;
    expect((await store.get("a"))?.n).toBe(1);
  });

  it("honours expiresAt from options", async () => {
    const store = opened(createMemorySessionStore());
    await store.set("a", { x: 1 }, { expiresAt: Date.now() - 1 });
    expect(await store.get("a")).toBeNull();
  });

  it("close() clears the periodic sweep interval (no timer leak on shutdown)", () => {
    const clear = vi.spyOn(globalThis, "clearInterval");
    try {
      const store = createMemorySessionStore();
      store.close();
      // `setInterval` is called once in the constructor; `close()` must clear it
      // so app shutdown doesn't leave a per-store sweep timer running.
      expect(clear).toHaveBeenCalled();
    } finally {
      clear.mockRestore();
    }
  });
});

describe("createSqliteSessionStore", () => {
  const sqlite = async () => {
    const store = await createSqliteSessionStore();
    if (!store) return null;
    return opened(store);
  };

  it("round-trips data, touches, and deletes", async () => {
    const store = await sqlite();
    if (!store) return; // bun:sqlite unavailable

    await store.set("s1", { user: "ada", role: "admin" }, { expiresAt: Date.now() + 60_000 });
    expect(await store.get("s1")).toEqual({ user: "ada", role: "admin" });

    await store.touch?.("s1", { expiresAt: Date.now() + 120_000 });
    expect(await store.get("s1")).toEqual({ user: "ada", role: "admin" });

    await store.delete("s1");
    expect(await store.get("s1")).toBeNull();
  });

  it("lazily removes expired rows on read", async () => {
    const store = await sqlite();
    if (!store) return;

    await store.set("exp", { x: 1 }, { expiresAt: Date.now() - 1 });
    expect(await store.get("exp")).toBeNull();
  });

  it("persists across store instances when file-backed", async () => {
    const file = join(
      tmpdir(),
      `ignex-session-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
    );
    const store1 = await createSqliteSessionStore(file);
    if (!store1) return;
    opened(store1);

    await store1.set("persist", { v: 42 });
    store1.close?.();

    const store2 = await createSqliteSessionStore(file);
    if (!store2) return;
    opened(store2);
    expect(await store2.get("persist")).toEqual({ v: 42 });
  });

  it("returns null when bun:sqlite is unavailable", async () => {
    // The fallback path is exercised under a non-bun runtime; under bun it
    // returns a real store. Guard with the availability of the module.
    let available = true;
    try {
      await import("bun:sqlite");
    } catch {
      available = false;
    }
    if (!available) {
      expect(await createSqliteSessionStore()).toBeNull();
    }
  });
});
