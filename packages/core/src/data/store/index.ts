/**
 * @fileoverview `data/store` — pluggable key-value stores (Laravel-style drivers).
 *
 * A generic {@link Store} contract with `memory` / `sqlite` / `file` drivers
 * plus a {@link createStoreManager} registry, so consumers swap storage
 * backends by name or register their own (e.g. Redis) via `extend`. Sessions,
 * jobs, the HTTP cache and rate-limit state all build on this layer.
 *
 * Modules: types, memory, sqlite, file, manager.
 */

export {
  createDriverManager,
  type DriverFactory,
  type DriverManager,
  type DriverManagerOptions,
} from "../drivers/manager";
export { createFileStore, type FileStoreOptions } from "./file";
export { createStoreManager, type StoreManagerOptions } from "./manager";
export { createMemoryStore, type MemoryStoreOptions } from "./memory";
export { createSqliteStore, type SqliteStoreOptions } from "./sqlite";
export type { MaybePromise, Store, StoreSetOptions } from "./types";
