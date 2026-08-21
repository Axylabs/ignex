/**
 * @fileoverview Session backing stores — pluggable `SessionStore` drivers.
 *
 * The {@link SessionStore} contract is implemented by a thin adapter
 * ({@link createSessionStoreFromStore}) over the generic `data/store` driver
 * layer, so any `Store` (memory, sqlite, file, or a user's custom driver) can
 * back sessions. `createMemorySessionStore` / `createSqliteSessionStore` keep
 * their historical signatures and semantics (copies on read/write, absolute
 * `expiresAt`, lazy expiry, sweep timer cleanup on `close`).
 */

import { createMemoryStore } from "../data/store/memory";
import { createSqliteStore } from "../data/store/sqlite";
import type { Store } from "../data/store/types";

/** Arbitrary session payload data (JSON-serializable). */
export type SessionData = Record<string, unknown>;

/** A pluggable session backing store (memory, SQLite, …). */
export interface SessionStore {
  get(id: string): Promise<SessionData | null>;
  set(id: string, data: SessionData, options?: { expiresAt?: number }): Promise<void>;
  delete(id: string): Promise<void>;
  touch?(id: string, options?: { expiresAt?: number }): Promise<void>;
  close?(): void;
}

/** Options for the session store adapters. */
export interface SessionStoreOptions {
  /** Session lifetime in seconds (default 3600). */
  ttlSeconds?: number;
}

/**
 * Wrap any {@link Store} as a {@link SessionStore}.
 *
 * Adds the session contract on top of the generic driver surface: values are
 * copied on read and write (caller mutations never leak into the store),
 * `expiresAt` is an absolute epoch-ms deadline, and `close()` releases the
 * backing store's resources.
 *
 * @param store - The generic store driver (memory / sqlite / file / custom).
 * @param options - Default session TTL.
 * @returns The session store.
 */
export const createSessionStoreFromStore = (
  store: Store,
  options: SessionStoreOptions = {},
): SessionStore => {
  const ttlMs = (options.ttlSeconds ?? 3600) * 1000;
  const defaultExpiry = (): number => Date.now() + ttlMs;

  return {
    async get(id) {
      const data = await store.get(id);
      if (data == null) return null;
      return { ...(data as SessionData) };
    },
    async set(id, data, opts) {
      await store.set(id, { ...data }, { expiresAt: opts?.expiresAt ?? defaultExpiry() });
    },
    async delete(id) {
      await store.delete(id);
    },
    async touch(id, opts) {
      await store.touch?.(id, { expiresAt: opts?.expiresAt ?? defaultExpiry() });
    },
    close() {
      store.close?.();
    },
  };
};

/**
 * In-memory session store with lazy expiry + periodic sweep (unref'd).
 *
 * Built on the generic memory store driver with session copy semantics.
 *
 * @param options - TTL + sweep tuning.
 * @returns The session store (see {@link SessionStore}).
 */
export const createMemorySessionStore = (
  options: SessionStoreOptions & { sweepIntervalMs?: number } = {},
): SessionStore => {
  const store = createMemoryStore({
    ttlMs: (options.ttlSeconds ?? 3600) * 1000,
    sweepIntervalMs: options.sweepIntervalMs ?? 60_000,
  });
  return createSessionStoreFromStore(store, options);
};

/**
 * SQLite-backed session store via `bun:sqlite`. Returns `null` when the module
 * is unavailable (e.g. running on Node without the polyfill) so callers can
 * fall back to the memory store. Expired rows are deleted lazily on read; a
 * `close()` is provided for clean shutdown.
 *
 * @param file - SQLite database file (default `:memory:`).
 * @param options - Session TTL.
 * @returns A `Promise` of the session store, or `null` when unavailable.
 */
export const createSqliteSessionStore = async (
  file = ":memory:",
  options: SessionStoreOptions = {},
): Promise<SessionStore | null> => {
  const store = await createSqliteStore(file, {
    table: "sessions",
    keyColumn: "id",
    valueColumn: "data",
  });
  if (!store) return null;
  return createSessionStoreFromStore(store, options);
};
