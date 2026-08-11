/**
 * @fileoverview `data` domain — data access, caching and validation.
 *
 * Modules: cache, dataloader, lru, query, schema, validation. Re-exported here
 * for internal and subpath consumers; the top-level `index.ts` is the
 * canonical public surface.
 */
export * from "./cache";
export * from "./dataloader";
export * from "./lru";
export * from "./query";
export * from "./schema";
export * from "./validation";
