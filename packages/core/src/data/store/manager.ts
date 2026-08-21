/**
 * @fileoverview Store manager — Laravel-style access to named `Store` drivers.
 *
 * Wraps the generic {@link createDriverManager} with the built-in `memory` /
 * `sqlite` / `file` drivers pre-registered, so consumers pick a backend by
 * name (`stores.driver("sqlite")`) and can register custom drivers via
 * `extend` — the same shape as Laravel's `Cache::store('redis')` /
 * `Cache::extend('redis', fn)`.
 */

import { join } from "node:path";
import { createDriverManager, type DriverManager } from "../drivers/manager";
import { createFileStore } from "./file";
import { createMemoryStore } from "./memory";
import { createSqliteStore } from "./sqlite";
import type { Store } from "./types";

/** Options for {@link createStoreManager}. */
export interface StoreManagerOptions {
  /** Default driver name used by `driver()` with no argument (default `memory`). */
  default?: string;
  /** Extra driver factories keyed by name (merged over the built-ins). */
  drivers?: Record<string, () => Store | Promise<Store>>;
}

/**
 * A Laravel-style store manager with the built-in drivers pre-registered:
 *
 * - `memory` — synchronous Map-backed (hot-path default);
 * - `sqlite` — `bun:sqlite`-backed (`:memory:` by default; falls back to
 *   `memory` when `bun:sqlite` is unavailable);
 * - `file` — JSON-lines file in `./.ignex/stores`.
 *
 * Register custom drivers with `extend(name, factory)`:
 *
 * ```ts
 * const stores = createStoreManager();
 * stores.extend("redis", () => createRedisStore());
 * const cache = stores.driver("redis");
 * ```
 *
 * @param options - Default driver + extra factories.
 * @returns The store manager (see {@link DriverManager}).
 */
export const createStoreManager = (options: StoreManagerOptions = {}): DriverManager<Store> => {
  const manager = createDriverManager<Store>({
    default: options.default ?? "memory",
    drivers: {
      memory: () => createMemoryStore(),
      sqlite: async () => (await createSqliteStore(":memory:")) ?? createMemoryStore(),
      file: () => createFileStore(joinDefaultStoreDir()),
    },
  });

  for (const [name, factory] of Object.entries(options.drivers ?? {})) {
    manager.extend(name, factory);
  }

  return manager;
};

/** Resolve the default file-store directory (`<cwd>/.ignex/stores`). */
const joinDefaultStoreDir = (): string => join(process.cwd(), ".ignex", "stores");
