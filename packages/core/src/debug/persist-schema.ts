/**
 * @fileoverview SQLite observatory schema — the tables the debugger's history
 * writes, plus the idempotent migrations applied on open.
 *
 * Split out of `persist.ts` so the storage contract (which columns a trace, a
 * span, a log record or a system sample keeps) is one reviewable list next to
 * the row↔wire mappers, and so adding a column is a line in {@link MIGRATIONS}
 * rather than an edit buried in the writer.
 *
 * Idempotence is what makes this safe to run on every boot: the `CREATE … IF
 * NOT EXISTS` block builds a fresh file, and every `ALTER TABLE … ADD COLUMN`
 * is applied best-effort — a database created before that column existed takes
 * it, an up-to-date one throws a duplicate-column error that the caller treats
 * as "already migrated".
 */

import type { BunSqliteDatabase } from "../platform/sqlite";

/** Schema applied on open (each statement idempotent). */
export const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS traces (
    id TEXT PRIMARY KEY,
    ts INTEGER NOT NULL,
    duration_ms REAL NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    route TEXT,
    status INTEGER NOT NULL,
    request_id TEXT,
    ip TEXT,
    error TEXT,
    error_stack TEXT,
    fault TEXT,
    fault_span_id INTEGER,
    request_url TEXT,
    request_headers TEXT,
    request_body TEXT,
    response_headers TEXT,
    response_body TEXT,
    response_body_truncated INTEGER NOT NULL DEFAULT 0,
    db_time_ms REAL NOT NULL DEFAULT 0,
    db_count INTEGER NOT NULL DEFAULT 0,
    span_count INTEGER NOT NULL DEFAULT 0,
    stages TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_traces_ts ON traces(ts)`,
  `CREATE TABLE IF NOT EXISTS spans (
    trace_id TEXT NOT NULL,
    sid INTEGER NOT NULL,
    parent_id INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    start_ms REAL NOT NULL,
    duration_ms REAL NOT NULL,
    open INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    fault TEXT,
    origin TEXT,
    attrs TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id)`,
  `CREATE TABLE IF NOT EXISTS logs (
    lid INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    attrs TEXT,
    trace_id TEXT,
    request_id TEXT,
    route TEXT,
    source TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts)`,
  `CREATE TABLE IF NOT EXISTS samples (
    ts INTEGER PRIMARY KEY,
    cpu_pct REAL NOT NULL,
    rss_mib REAL NOT NULL,
    heap_mib REAL NOT NULL,
    event_loop_delay_ms REAL NOT NULL,
    active_requests INTEGER NOT NULL
  )`,
];

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` cannot
 * extend an existing file, so each is applied best-effort on open; a
 * duplicate-column throw is the "already applied" no-op signal.
 */
export const MIGRATIONS: readonly string[] = [
  `ALTER TABLE traces ADD COLUMN response_body TEXT`,
  `ALTER TABLE traces ADD COLUMN response_body_truncated INTEGER NOT NULL DEFAULT 0`,
  // Fault classification columns (origin/kind/code/hints/cause chain) — the
  // debugger's copy of what the terminal reporter already knows.
  `ALTER TABLE traces ADD COLUMN fault TEXT`,
  `ALTER TABLE traces ADD COLUMN fault_span_id INTEGER`,
  `ALTER TABLE spans ADD COLUMN fault TEXT`,
];

/**
 * Apply the schema and every migration to an open database.
 *
 * @param db - An open `bun:sqlite` handle.
 */
export const applySchema = (db: BunSqliteDatabase): void => {
  for (const stmt of SCHEMA) db.run(stmt);
  for (const stmt of MIGRATIONS) {
    try {
      db.run(stmt);
    } catch {
      /* column already exists (or the table is absent) — nothing to do */
    }
  }
};
