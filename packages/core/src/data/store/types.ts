/**
 * @fileoverview Store driver contract — a generic key-value store with TTL.
 *
 * This is the storage backbone shared by sessions, jobs, the HTTP cache and
 * rate-limit state. Every driver implements the same surface, so consumers can
 * swap backends (memory ↔ sqlite ↔ file ↔ custom) without changing their code —
 * the Laravel-style driver story lives on top in `data/drivers`.
 *
 * Sync-capable: methods may return plain values (the memory/file/sqlite drivers
 * are fully synchronous after construction — zero Promise/microtask on the hot
 * path) or `Promise`s (custom async drivers like Redis). `await` works either
 * way; hot paths can branch on `instanceof Promise` like the rest of ignex.
 */

/** A value or a promise of it — used to keep Store methods sync-capable. */
export type MaybePromise<T> = T | Promise<T>;

/** Options for {@link Store.set} / {@link Store.touch}. */
export interface StoreSetOptions {
  /**
   * Time-to-live in milliseconds from `now`. When omitted, the driver's
   * default TTL applies (or no expiry when the driver has none).
   */
  ttlMs?: number;
  /**
   * Absolute epoch-ms expiry, overriding `ttlMs`. Lets callers express wall-
   * clock deadlines (e.g. a session's `expiresAt`) without computing deltas.
   */
  expiresAt?: number;
}

/**
 * Resolve a write's effective absolute expiry from `ttlMs` / `expiresAt`.
 *
 * Shared by every driver so TTL semantics never drift: `expiresAt` wins when
 * present; otherwise `now + ttlMs`; otherwise `0` (never). A non-positive TTL
 * is treated as already-expired (`now`), matching session expiry semantics.
 *
 * @internal
 */
export const resolveExpiry = (
  options: StoreSetOptions | undefined,
  defaultTtlMs: number | undefined,
  now: number,
): number => {
  if (options?.expiresAt !== undefined) return options.expiresAt;
  const ttlMs = options?.ttlMs ?? defaultTtlMs;
  if (ttlMs === undefined) return 0;
  return ttlMs > 0 ? now + ttlMs : now;
};

/**
 * A generic key-value store with optional per-key TTL.
 *
 * Values should be JSON-serializable when using the sqlite/file drivers (they
 * persist via `JSON.stringify`); the memory driver stores references as-is.
 */
export interface Store {
  /** Read a key's value, or `null` when missing or expired. */
  get(key: string): MaybePromise<unknown | null>;
  /**
   * Write a key's value. Replaces any existing value; when `ttlMs`/`expiresAt`
   * is set the entry expires at that point.
   */
  set(key: string, value: unknown, options?: StoreSetOptions): MaybePromise<void>;
  /** Remove a key. Missing keys are a no-op. */
  delete(key: string): MaybePromise<void>;
  /** Extend a live entry's expiry (drivers without TTL may omit this). */
  touch?(key: string, options?: StoreSetOptions): MaybePromise<void>;
  /** Release driver resources (timers, DB handles). Optional — call on shutdown. */
  close?(): MaybePromise<void>;
}
