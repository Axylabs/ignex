/**
 * @fileoverview Enterprise DATA-INTEGRITY regression suite.
 *
 * Pins the invariants that keep durable state uncorrupted under crashes,
 * concurrent writers, and hostile inputs:
 *  - the file store's tmp+rename protocol survives a crashed mid-write
 *    (stray `.tmp` is inert) and a torn/truncated final line on reload;
 *  - two concurrent writers on one session id through `SessionStore.update`
 *    never lose a mutation (get→compute→set interleavings silently drop one);
 *  - a shared atomic rate-limit store counts authoritatively under a
 *    concurrent hammer — total admitted never exceeds the window budget;
 *  - file-store entry hygiene: repeated keys never duplicate rows, non-positive
 *    TTLs clamp to already-expired, and oversized TTL math stays finite.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createApp,
  createFileStore,
  createMemorySessionStore,
  rateLimit,
  type SessionStore,
} from "@ignex/core";
import { describe, expect, it } from "vitest";
import type { FixedWindowEntry } from "../src/data/ratelimit";
import type { RateLimitStore } from "../src/plugins/ratelimit";

describe("file store — crash & corruption integrity", () => {
  it("ignores a stray `.tmp` left by a crashed writer (tmp+rename is atomic)", () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-crash-"));
    try {
      // Simulate a crash mid-write: stale temp, still-valid committed file.
      writeFileSync(join(dir, "s.jsonl"), '{"key":"old","value":"old","expiresAt":0}\n');
      writeFileSync(join(dir, "s.jsonl.tmp"), "garbage from a crashed process");

      const store = createFileStore(dir, { file: "s.jsonl" });
      store.set("k", "v"); // persistNow REPLACES the tmp, then renames atomically
      store.close();

      const raw = readFileSync(join(dir, "s.jsonl"), "utf8");
      expect(raw).not.toContain("crashed process");
      expect(raw).toContain('"k"');

      // A fresh open is clean — the stray tmp was never read.
      const reopened = createFileStore(dir, { file: "s.jsonl" });
      expect(reopened.get("k")).toBe("v");
      expect(reopened.get("old")).toBe("old");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a torn final line on reload — one partial write cannot take the store down", () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-trunc-"));
    try {
      mkdirSync(dir, { recursive: true });
      // Valid row, then a TRUNCATED second row (no closing brace / newline).
      writeFileSync(
        join(dir, "s.jsonl"),
        ['{"key":"a","value":"A","expiresAt":0}', '{"key":"b","value":"B"'].join("\n"),
      );
      const store = createFileStore(dir, { file: "s.jsonl" });
      expect(store.get("a")).toBe("A"); // intact rows still serve
      expect(store.get("b")).toBeNull(); // torn row skipped, store stays up
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** `createMemorySessionStore` always provides `update` — narrow the optional
 * member so the tests can call it without non-null assertions. */
type UpdatableSessionStore = SessionStore & {
  update: NonNullable<SessionStore["update"]>;
};

describe("session store — concurrent writers never lose a mutation", () => {
  it("two racing writers on one session id both land (merge, not last-write-wins)", async () => {
    const store = createMemorySessionStore({ ttlSeconds: 3600 }) as UpdatableSessionStore;
    await store.set("s1", { n: 0 });
    await Promise.all([
      store.update("s1", (cur) => ({ ...cur, x: 1 })),
      store.update("s1", (cur) => ({ ...cur, y: 2 })),
    ]);
    // BOTH mutations reached the store — without update() the get→compute→set
    // interleaving reads the same pre-commit snapshot twice and drops one.
    expect(await store.get("s1")).toEqual({ n: 0, x: 1, y: 2 });
    store.close();
  });

  it("update() honours TTL semantics (explicit past deadline ⇒ dead on read)", async () => {
    const store = createMemorySessionStore() as UpdatableSessionStore;
    await store.update("gone", (cur) => ({ ...cur, fresh: true }), {
      expiresAt: Date.now() - 1,
    });
    expect(await store.get("gone")).toBeNull();
    store.close();
  });
});

describe("rate limiting — atomic shared-store counting", () => {
  /** A `RateLimitStore` whose `incr` is a fully synchronous read→write, so
   * each call is atomic under JS single-threading (no torn increments). */
  const createAtomicStore = (): RateLimitStore => {
    const buckets = new Map<string, FixedWindowEntry>();
    return {
      get(key) {
        return buckets.get(key);
      },
      set(key, state) {
        buckets.set(key, state as FixedWindowEntry);
      },
      async incr(key, windowMs, now) {
        const entry = buckets.get(key);
        const next =
          entry && entry.resetTime > now
            ? { count: entry.count + 1, resetTime: entry.resetTime }
            : { count: 1, resetTime: now + windowMs };
        buckets.set(key, next);
        return { ...next };
      },
    };
  };

  it("a 300-request hammer over one shared window admits exactly maxRequests — no drift", async () => {
    const app = createApp({
      plugins: [rateLimit({ store: createAtomicStore(), windowMs: 60_000, maxRequests: 50 })],
      handler: () => new Response("ok"),
    });
    const results = await Promise.all(
      Array.from({ length: 300 }, () => app.handler(new Request("http://localhost/"))),
    );
    const allowed = results.filter((response) => response.status === 200).length;
    expect(allowed).toBe(50); // the full budget, and NO MORE — no torn increments
    for (const response of results) expect([200, 429]).toContain(response.status);
  });
});

describe("file store — entry hygiene", () => {
  it("re-setting one key 200× leaves exactly ONE durable row", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-dedup-"));
    try {
      const store = createFileStore(dir, { file: "s.jsonl", writeCoalesceMs: 60_000 });
      for (let i = 0; i < 200; i++) store.set("hot", { i });
      store.close(); // flush the coalesced rewrite exactly once
      const lines = readFileSync(join(dir, "s.jsonl"), "utf8").split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
      expect((JSON.parse(lines[0]) as { value: { i: number } }).value.i).toBe(199);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("non-positive TTL clamps to already-expired; oversized TTL math stays finite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ignex-filestore-ttl-"));
    try {
      const store = createFileStore(dir, { file: "s.jsonl" });
      store.set("dead", "v", { ttlMs: 0 }); // ttlMs ≤ 0 ⇒ expires at `now`
      expect(store.get("dead")).toBeNull();
      store.set("far", "q", { ttlMs: 2 ** 40 }); // oversized but finite
      expect(store.get("far")).toBe("q");
      store.close();

      const rows = readFileSync(join(dir, "s.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { key: string; expiresAt: number });
      const farRow = rows.find((row) => row.key === "far");
      if (!farRow) throw new Error("expected the `far` row to be persisted");
      expect(Number.isFinite(farRow.expiresAt)).toBe(true);
      expect(farRow.expiresAt).toBeGreaterThan(Date.now() - 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
