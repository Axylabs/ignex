/**
 * @fileoverview File store driver — a JSON-lines file-backed `Store`.
 *
 * A portable (`node:fs`) file store that persists entries as one JSON object
 * per line (`{ key, value, expiresAt }`) with atomic tmp+rename writes, so a
 * crash or concurrent reader can never observe a truncated file. Reads/writes
 * are synchronous (`readFileSync`/`writeFileSync`), mirroring the file job
 * store's approach for portability across Bun and Node.
 *
 * Efficiency: every mutation previously rewrote the whole file — O(N) write
 * amplification on write-heavy workloads. `writeCoalesceMs` (default 0 =
 * durable sync writes, unchanged) schedules the rewrite on a trailing timer so
 * bursts of mutations share ONE disk write. Coalesced mode trades a bounded
 * crash window (`writeCoalesceMs`) for throughput; `close()` flushes pending
 * writes.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveExpiry, type Store } from "./types";

/** Options for {@link createFileStore}. */
export interface FileStoreOptions {
  /** Default TTL in ms when `set()` omits `ttlMs` (default: no expiry). */
  ttlMs?: number;
  /** File name inside `dir` (default `store.jsonl`). */
  file?: string;
  /**
   * Hard cap on live entries (default 100_000; `0` = unbounded). On overflow,
   * expired entries are dropped first, then oldest-inserted are evicted.
   */
  maxEntries?: number;
  /**
   * Coalesce whole-file rewrites within this window (default 0 = write
   * synchronously on every mutation). Values > 0 batch bursts into one disk
   * write; the trade-off is a bounded loss window on hard crash.
   */
  writeCoalesceMs?: number;
}

interface FileEntry {
  key: string;
  value: unknown;
  expiresAt: number; // 0 = never
}

/**
 * Create a JSON-lines file store.
 *
 * The whole store is kept in memory and rewritten to disk (tmp + atomic
 * rename) per mutation — or coalesced when `writeCoalesceMs > 0`. Expired
 * entries are skipped on read. `close()` flushes any coalesced write.
 *
 * @param dir - Directory holding the store file (created if missing).
 * @param options - Default TTL, file name, entry cap, write coalescing.
 * @returns The file store (see {@link Store}).
 */
export const createFileStore = (dir: string, options: FileStoreOptions = {}): Store => {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, options.file ?? "store.jsonl");
  const maxEntries =
    options.maxEntries === 0 ? Number.POSITIVE_INFINITY : (options.maxEntries ?? 100_000);
  const writeCoalesceMs = Math.max(0, options.writeCoalesceMs ?? 0);

  const entries = new Map<string, FileEntry>();

  const load = (): void => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as FileEntry;
        if (entry && typeof entry.key === "string") entries.set(entry.key, entry);
      } catch {
        // Skip corrupt lines; the rest of the file stays usable.
      }
    }
    enforceCap();
  };

  const persistNow = (): void => {
    const tmp = `${file}.tmp`;
    const lines = [...entries.values()].map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(tmp, lines ? `${lines}\n` : "");
    renameSync(tmp, file);
  };

  let persistTimer: ReturnType<typeof setTimeout> | null = null;

  /** Persist immediately, or schedule one trailing write inside the window. */
  const persist = (): void => {
    if (writeCoalesceMs === 0) {
      persistNow();
      return;
    }
    if (persistTimer !== null) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      try {
        persistNow();
      } catch (err) {
        console.error("[ignex] file store: coalesced write failed:", err);
      }
    }, writeCoalesceMs);
    persistTimer.unref?.();
  };

  const flushPending = (): void => {
    if (persistTimer === null) return;
    clearTimeout(persistTimer);
    persistTimer = null;
    try {
      persistNow();
    } catch (err) {
      console.error("[ignex] file store: flush on close failed:", err);
    }
  };

  /** Drop expired entries first, then FIFO-evict down to the cap. */
  function enforceCap(): void {
    if (entries.size <= maxEntries) return;
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entries.size <= maxEntries) break;
      if (entry.expiresAt !== 0 && entry.expiresAt <= now) entries.delete(key);
    }
    while (entries.size > maxEntries) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  load();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== 0 && entry.expiresAt <= Date.now()) {
        entries.delete(key);
        persist();
        return null;
      }
      return entry.value;
    },

    set(key, value, opts) {
      entries.set(key, {
        key,
        value,
        expiresAt: resolveExpiry(opts, options.ttlMs, Date.now()),
      });
      enforceCap();
      persist();
    },

    delete(key) {
      if (!entries.delete(key)) return;
      persist();
    },

    touch(key, opts) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.expiresAt = resolveExpiry(opts, options.ttlMs, Date.now());
      persist();
    },

    close() {
      flushPending();
    },
  } satisfies Store;
};
