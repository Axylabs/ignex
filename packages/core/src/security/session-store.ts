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
  /**
   * Atomically read-modify-write a session ON the backing store: the updater
   * receives the current data (`null` when absent) and its return value
   * replaces the session (serialized per store instance, so concurrent
   * `update` calls to the same id never lose a mutation — the get→compute→set
   * interleaving outside this primitive silently drops one writer).
   *
   * A returned `null` deletes the session and resolves to `null`.
   */
  update?(
    id: string,
    updater: (current: SessionData | null) => SessionData | null | Promise<SessionData | null>,
    options?: { expiresAt?: number },
  ): Promise<SessionData | null>;
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

  /**
   * Serialized mutation chain: each `set`/`delete`/`touch`/`update` runs only
   * after the previous one commits. Concurrency is the async-read trap — the
   * sync drivers still yield on `await store.get(...)`, so two callers doing
   * get→compute→set can both read the same pre-commit snapshot and lose one
   * another's update. Serializing keeps every mutation's read fresh.
   */
  let mutationTail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const run = mutationTail.then(() => Promise.resolve().then(fn));
    mutationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    async get(id) {
      const data = await store.get(id);
      if (data == null) return null;
      return { ...(data as SessionData) };
    },
    set(id, data, opts) {
      return serialize(async () => {
        await store.set(id, { ...data }, { expiresAt: opts?.expiresAt ?? defaultExpiry() });
      });
    },
    async delete(id) {
      return serialize(async () => {
        await store.delete(id);
      });
    },
    touch(id, opts) {
      return serialize(async () => {
        await store.touch?.(id, { expiresAt: opts?.expiresAt ?? defaultExpiry() });
      });
    },
    update(id, updater, opts) {
      return serialize(async () => {
        const current = await store.get(id);
        const next = await updater(current == null ? null : { ...(current as SessionData) });
        if (next == null) {
          await store.delete(id);
          return null;
        }
        await store.set(id, { ...next }, { expiresAt: opts?.expiresAt ?? defaultExpiry() });
        return { ...next };
      });
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
