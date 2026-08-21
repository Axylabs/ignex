/**
 * @fileoverview Generic driver manager — the Laravel-style `Manager` primitive.
 *
 * A manager owns a **registry of named driver factories** plus a **default
 * driver name**, and hands out lazily-created, memoized driver instances:
 *
 * ```ts
 * const cache = createDriverManager({
 *   default: "memory",
 *   drivers: {
 *     memory: () => createMemoryStore(),
 *     sqlite: () => createSqliteStore(":memory:"),
 *   },
 * });
 * const store = cache.driver();          // → the memoized memory store
 * const other = cache.driver("sqlite");  // → the memoized sqlite store
 * ```
 *
 * `register` / `extend` add or replace a named factory at any time, so
 * consumers can plug in their own drivers (e.g. a Redis store) exactly like
 * Laravel's `Cache::extend('redis', fn () => ...)`.
 *
 * Instances are created once per driver name and reused for the life of the
 * manager (`forget` clears a memoized instance so the next `driver()` call
 * re-creates it — useful after config changes or in tests).
 */

/**
 * A factory that produces a driver instance. May return a `Promise` for
 * async driver setup (e.g. `bun:sqlite` bootstrap).
 */
export type DriverFactory<T> = () => T | Promise<T>;

/** Options for {@link createDriverManager}. */
export interface DriverManagerOptions<T> {
  /** Name of the default driver used by `driver()` with no argument. */
  default?: string;
  /** Initial driver factories keyed by name. */
  drivers?: Record<string, DriverFactory<T>>;
}

/**
 * A Laravel-style driver manager: named factory registry + memoized instances.
 *
 * @typeParam T - The driver type (e.g. `Store`, `SessionStore`, `JobStore`).
 */
export interface DriverManager<T> {
  /**
   * Resolve a driver instance by name (creating + memoizing on first use).
   * With no argument, resolves the default driver.
   *
   * @param name - Driver name; defaults to the manager's `default`.
   * @throws RangeError when the name is unknown.
   */
  driver(name?: string): T | Promise<T>;
  /**
   * Register a new driver factory, or replace an existing one.
   *
   * @param name - Driver name.
   * @param factory - Factory producing the driver instance.
   */
  register(name: string, factory: DriverFactory<T>): void;
  /** Alias of {@link DriverManager.register} (Laravel's `extend`). */
  extend(name: string, factory: DriverFactory<T>): void;
  /** Change the default driver used by `driver()` with no argument. */
  setDefault(name: string): void;
  /**
   * Drop the memoized instance(s) so the next `driver()` call re-creates them.
   * A rejected async factory's memo is also cleared, so the next call retries.
   *
   * @param name - Driver name to forget; omit to forget every instance.
   */
  forget(name?: string): void;
  /** True when a factory is registered under `name`. */
  has(name: string): boolean;
  /** All registered driver names (sorted). */
  names(): string[];
}

/**
 * Create a Laravel-style driver manager.
 *
 * @param options - Default driver + initial factories.
 * @returns The manager (see {@link DriverManager}).
 */
export const createDriverManager = <T>(options: DriverManagerOptions<T> = {}): DriverManager<T> => {
  const factories = new Map<string, DriverFactory<T>>(Object.entries(options.drivers ?? {}));
  const instances = new Map<string, T | Promise<T>>();
  let defaultName = options.default;

  const assertKnown = (name: string): void => {
    if (!factories.has(name)) {
      throw new RangeError(
        `Unknown driver "${name}". Registered: ${[...factories.keys()].join(", ") || "(none)"}`,
      );
    }
  };

  return {
    driver(name) {
      const resolved = name ?? defaultName;
      if (resolved === undefined) {
        throw new RangeError(
          "DriverManager has no default driver. Pass a name or configure `default`.",
        );
      }
      assertKnown(resolved);
      const memo = instances.get(resolved);
      if (memo !== undefined) return memo;
      const factory = factories.get(resolved);
      if (factory === undefined) {
        // Unreachable after assertKnown; kept for type narrowing.
        throw new RangeError(`Unknown driver "${resolved}".`);
      }
      const instance = factory();
      instances.set(resolved, instance);
      return instance;
    },

    register(name, factory) {
      factories.set(name, factory);
      instances.delete(name);
    },

    extend(name, factory) {
      factories.set(name, factory);
      instances.delete(name);
    },

    setDefault(name) {
      assertKnown(name);
      defaultName = name;
    },

    forget(name) {
      if (name !== undefined) {
        instances.delete(name);
        return;
      }
      instances.clear();
    },

    has(name) {
      return factories.has(name);
    },

    names() {
      return [...factories.keys()].sort();
    },
  };
};
