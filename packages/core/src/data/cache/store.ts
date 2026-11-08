/**
 * @fileoverview Binary-safe HTTP response cache adapter for generic stores.
 */

import type { Store } from "../store/types";
import type { CachedHttpResponse, HttpResponseCacheStore } from "./types";

/** HTTP cache store backed by any generic store, including Redis. */
export interface PersistentHttpResponseCacheStore extends HttpResponseCacheStore {
  close(): Promise<void>;
}

type StoredResponse = Omit<CachedHttpResponse, "body"> & { body: string | null };

const encode = (entry: CachedHttpResponse): StoredResponse => ({
  ...entry,
  body: entry.body === null ? null : Buffer.from(entry.body).toString("base64"),
});

const decode = (value: unknown): CachedHttpResponse | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const entry = value as StoredResponse;
  if (typeof entry.storedAt !== "number" || typeof entry.ttlMs !== "number") return undefined;
  return {
    ...entry,
    body:
      typeof entry.body === "string"
        ? Uint8Array.from(Buffer.from(entry.body, "base64")).buffer
        : null,
  };
};

/** Adapt a generic store without JSON-corrupting binary response bodies. */
export const createPersistentHttpCacheStore = (
  store: Store,
  options: { staleTtlMs?: number } = {},
): PersistentHttpResponseCacheStore => ({
  async get(key, readOptions) {
    const entry = decode(await store.get(key));
    if (!entry) return undefined;
    const stale = Date.now() - entry.storedAt >= entry.ttlMs;
    return stale && readOptions?.allowStale !== true ? undefined : entry;
  },
  async set(key, value, writeOptions) {
    const ttlMs = writeOptions?.ttlMs ?? value.ttlMs;
    const staleTtlMs = writeOptions?.staleTtlMs ?? options.staleTtlMs ?? 300_000;
    await store.set(key, encode(value), { ttlMs: ttlMs + staleTtlMs });
  },
  async close() {
    await store.close?.();
  },
});
