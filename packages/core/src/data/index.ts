/**
 * @fileoverview `data` domain — data access, caching and validation.
 *
 * Modules: cache, dataloader, drivers, lru, query, ratelimit, schema, store,
 * validation. Re-exported here for internal and subpath consumers; the
 * top-level `index.ts` is the canonical public surface.
 */
export * from "./cache";
export * from "./dataloader";
export * from "./drivers";
export * from "./lru";
export * from "./query";
export * from "./ratelimit";
export * from "./schema";
export * from "./store";
export * from "./validation";
