/**
 * @fileoverview `bun:sqlite` bootstrap — a typed loader shared by the SQLite
 * job store and the SQLite session store so they can't drift on the module
 * surface or the availability fallback (both fall back to their non-SQLite
 * store when `bun:sqlite` is unavailable, e.g. under Node).
 */

/** Minimal structural surface of `bun:sqlite`'s `Database` that we rely on. */
export interface BunSqliteDatabase {
  run(sql: string, params?: unknown[]): unknown;
  query(sql: string): { all(...params: unknown[]): unknown[] };
  close(): void;
}

/**
 * Load the `bun:sqlite` `Database` constructor, or `null` when the module is
 * unavailable (Node without a polyfill) or its surface is not a constructor.
 * A minimal structural type replaces the former `any` so callers get checked
 * access to the small subset of the API they use.
 */
export const loadBunSqlite = async (): Promise<
  (new (path: string) => BunSqliteDatabase) | null
> => {
  try {
    const mod = (await import("bun:sqlite")) as { Database?: unknown };
    const Database = mod.Database;
    if (typeof Database !== "function") return null;
    return Database as unknown as new (
      path: string,
    ) => BunSqliteDatabase;
  } catch {
    return null;
  }
};
