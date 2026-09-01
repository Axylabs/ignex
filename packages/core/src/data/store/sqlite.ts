/**
 * @fileoverview SQLite store driver — a `bun:sqlite`-backed `Store`.
 *
 * A single generic `kv` table (key TEXT PRIMARY KEY, value TEXT, expires_at
 * INTEGER) with lazy per-key expiry on read. Returns `null` when `bun:sqlite`
 * is unavailable (e.g. running on Node without a polyfill) so callers can fall
 * back to the memory driver — the same availability pattern as the session and
 * job stores.
 */

import { loadBunSqlite } from "../../platform/sqlite";
import { resolveExpiry, type Store } from "./types";

/** Options for {@link createSqliteStore}. */
export interface SqliteStoreOptions {
  /** Default TTL in ms when `set()` omits `ttlMs` (default: no expiry). */
  ttlMs?: number;
  /** Table name (default `kv`). */
  table?: string;
  /** Primary-key column name (default `key`). */
  keyColumn?: string;
  /** Value column name (default `value`). */
  valueColumn?: string;
  /** Expiry column name (default `expires_at`). */
  expiresColumn?: string;
}

/**
 * Create a SQLite-backed store.
 *
 * Entries live in a single table (configurable via `table` with optional
 * column-name mapping so callers can reuse existing schemas); expired rows are
 * deleted lazily on read. `close()` closes the database handle.
 *
 * @param file - SQLite database file (default `:memory:`).
 * @param options - Default TTL, table name and column mapping.
 * @returns A `Promise` of the store, or `null` when `bun:sqlite` is unavailable.
 */
export const createSqliteStore = async (
  file = ":memory:",
  options: SqliteStoreOptions = {},
): Promise<Store | null> => {
  const Database = await loadBunSqlite();
  if (!Database) return null;

  const table = options.table ?? "kv";
  const keyCol = options.keyColumn ?? "key";
  const valueCol = options.valueColumn ?? "value";
  const expiresCol = options.expiresColumn ?? "expires_at";
  const db = new Database(file);
  // Concurrent-writer hardening: without WAL, a second process (or the job
  // queue + request path sharing this file) trips over writer locks and gets
  // SQLITE_BUSY errors. busy_timeout makes writers wait instead of failing;
  // synchronous=NORMAL is the recommended WAL durability/perf point.
  try {
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA synchronous = NORMAL");
    db.run("PRAGMA busy_timeout = 5000");
  } catch {
    // :memory: databases (and some builds) reject journal_mode changes —
    // harmless, the table below still works.
  }
  db.run(
    `CREATE TABLE IF NOT EXISTS ${table} (${keyCol} TEXT PRIMARY KEY, ${valueCol} TEXT NOT NULL, ${expiresCol} INTEGER NOT NULL)`,
  );
  const run = db.run.bind(db);
  const one = (sql: string, params: unknown[]): { value: string; expires: number } | null =>
    (db.query(sql).all(...params) as Array<{ value: string; expires: number }>)[0] ?? null;

  const valueColRef = valueCol;
  const expiresColRef = expiresCol;
  const keyColRef = keyCol;

  return {
    get(key) {
      const row = one(
        `SELECT ${valueColRef} AS value, ${expiresColRef} AS expires FROM ${table} WHERE ${keyColRef} = ?`,
        [key],
      );
      if (!row) return null;
      if (row.expires !== 0 && row.expires <= Date.now()) {
        run(`DELETE FROM ${table} WHERE ${keyColRef} = ?`, [key]);
        return null;
      }
      try {
        return JSON.parse(row.value) as unknown;
      } catch {
        run(`DELETE FROM ${table} WHERE ${keyColRef} = ?`, [key]);
        return null;
      }
    },

    set(key, value, opts) {
      run(
        `INSERT INTO ${table} (${keyColRef}, ${valueColRef}, ${expiresColRef}) VALUES (?, ?, ?) ON CONFLICT(${keyColRef}) DO UPDATE SET ${valueColRef} = excluded.${valueColRef}, ${expiresColRef} = excluded.${expiresColRef}`,
        [key, JSON.stringify(value), resolveExpiry(opts, options.ttlMs, Date.now())],
      );
    },

    delete(key) {
      run(`DELETE FROM ${table} WHERE ${keyColRef} = ?`, [key]);
    },

    touch(key, opts) {
      run(`UPDATE ${table} SET ${expiresColRef} = ? WHERE ${keyColRef} = ?`, [
        resolveExpiry(opts, options.ttlMs, Date.now()),
        key,
      ]);
    },

    close() {
      db.close();
    },
  } satisfies Store;
};
