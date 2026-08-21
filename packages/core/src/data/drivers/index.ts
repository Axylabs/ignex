/**
 * @fileoverview `data/drivers` — the generic Laravel-style driver manager.
 *
 * `createDriverManager` is the reusable registry primitive behind the store
 * manager (`data/store`), the session stores, and any future driver-managed
 * feature (cache backends, queues, …). Kept dependency-free so every domain
 * can build on it.
 */

export {
  createDriverManager,
  type DriverFactory,
  type DriverManager,
  type DriverManagerOptions,
} from "./manager";
