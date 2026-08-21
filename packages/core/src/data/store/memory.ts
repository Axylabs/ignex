/**
 * @fileoverview Memory store driver — a synchronous Map-backed `Store`.
 *
 * The hot-path default: zero async (no Promises, no microtasks) with lazy
 * per-key expiry plus an optional unref'd periodic sweep that reclaims expired
 * keys so a long-lived process doesn't accumulate dead entries.
 */

import { resolveExpiry, type Store } from "./types";

/** Options for {@link createMemoryStore}. */
export interface MemoryStoreOptions {
  /** Default TTL in ms when `set()` omits `ttlMs` (default: no expiry). */
  ttlMs?: number;
  /** Sweep interval in ms (default 60_000; `0` disables the sweep timer). */
  sweepIntervalMs?: number;
}

interface Entry {
  value: unknown;
  expiresAt: number; // 0 = never
}

const expired = (entry: Entry, now: number): boolean =>
  entry.expiresAt !== 0 && entry.expiresAt <= now;

/**
 * Create a synchronous in-memory store.
 *
 * Reads/writes are plain Map operations (no Promises). Entries expire lazily on
 * read; a periodic unref'd sweep (default 60s) additionally reclaims expired
 * keys. `close()` clears the sweep timer.
 *
 * @param options - Default TTL + sweep tuning.
 * @returns The memory store (see {@link Store}).
 */
export const createMemoryStore = (options: MemoryStoreOptions = {}): Store => {
  const entries = new Map<string, Entry>();
  const sweepIntervalMs = options.sweepIntervalMs ?? 60_000;

  const sweep = (): void => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (expired(entry, now)) entries.delete(key);
    }
  };

  const interval = sweepIntervalMs > 0 ? setInterval(sweep, sweepIntervalMs) : undefined;
  interval?.unref?.();

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      if (expired(entry, Date.now())) {
        entries.delete(key);
        return null;
      }
      return entry.value;
    },

    set(key, value, opts) {
      entries.set(key, {
        value,
        expiresAt: resolveExpiry(opts, options.ttlMs, Date.now()),
      });
    },

    delete(key) {
      entries.delete(key);
    },

    touch(key, opts) {
      const entry = entries.get(key);
      if (!entry) return;
      entry.expiresAt = resolveExpiry(opts, options.ttlMs, Date.now());
    },

    close() {
      if (interval !== undefined) clearInterval(interval);
      entries.clear();
    },
  } satisfies Store;
};
