/**
 * @fileoverview ObservatoryDb — local SQLite persistence for the debugger.
 *
 * Everything the observatory records (finalized request traces + spans,
 * structured logs, system samples) is queued in memory and flushed in
 * batches to a WAL-mode SQLite database (via `bun:sqlite`, zero new
 * dependencies). This gives the dashboard and MCP agents **history that
 * survives restarts** — the "what happened before I got here" half of
 * debugging — plus retention pruning so the file stays bounded.
 *
 * The hot path never awaits the db: pushes append to plain arrays; a timer
 * flushes inside a transaction. When `bun:sqlite` is unavailable (Node)
 * every method degrades to the in-memory queue with `available: false`.
 */

import { type BunSqliteDatabase, loadBunSqlite } from "../platform/sqlite";
import type {
  HistoryQuery,
  HistoryTraceSummary,
  LogRecord,
  PersistStatus,
  RequestTrace,
  SystemSample,
} from "./types";

/** Options for {@link ObservatoryDb}. */
export interface ObservatoryDbOptions {
  /**
   * Database file path. Default `<cwd>/.ignex/observatory.db`. The parent
   * directory is created on open; `":memory:"` keeps everything in-process.
   */
  readonly path?: string;
  /** Batch flush interval in ms. Default 1000. */
  readonly flushIntervalMs?: number;
  /** Delete rows older than this many seconds while pruning. Default 7 days. */
  readonly maxAgeSec?: number;
  /** Hard per-table row cap applied during pruning. Default 100_000. */
  readonly maxRows?: number;
  /** Minimum interval between prune passes in ms. Default 60_000. */
  readonly pruneIntervalMs?: number;
  /** Injectable `bun:sqlite` loader (tests); defaults to {@link loadBunSqlite}. */
  readonly loadSqlite?: typeof loadBunSqlite;
}

const DEFAULT_PATH = ".ignex/observatory.db";

/** Schema applied on open (each statement idempotent). */
const SCHEMA: readonly string[] = [
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
 * Queue + batch-write SQLite sink for observatory data. Create with
 * {@link ObservatoryDb.create}; pushes are synchronous and instant, writes
 * happen on the flush timer.
 */
export class ObservatoryDb {
  private constructor(
    private readonly db: BunSqliteDatabase | null,
    private readonly filePath: string,
    private options: Required<
      Pick<ObservatoryDbOptions, "flushIntervalMs" | "maxAgeSec" | "maxRows" | "pruneIntervalMs">
    >,
  ) {}

  private traceQueue: RequestTrace[] = [];
  private logQueue: LogRecord[] = [];
  private sampleQueue: SystemSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPruneAt = 0;
  private written = 0;
  private lastFlushAt: number | null = null;
  private lastError: string | null = null;

  /**
   * Open (and migrate) the database, then prepare flushing.
   *
   * @returns A ready instance — or an instance with no database handle when
   * `bun:sqlite` is unavailable or the file cannot be opened (`status()
   * .available === false`; every push becomes a cheap no-op so the app is
   * never taken down by its own debugger).
   */
  static async create(options: ObservatoryDbOptions = {}): Promise<ObservatoryDb | null> {
    const Database = await (options.loadSqlite ?? loadBunSqlite)();
    const path = options.path ?? `${process.cwd()}/${DEFAULT_PATH}`;
    const opts = {
      flushIntervalMs: options.flushIntervalMs ?? 1000,
      maxAgeSec: options.maxAgeSec ?? 7 * 24 * 3600,
      maxRows: options.maxRows ?? 100_000,
      pruneIntervalMs: options.pruneIntervalMs ?? 60_000,
    };
    if (!Database) return new ObservatoryDb(null, path, opts);
    try {
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      if (dir && path !== ":memory:") {
        const { mkdirSync } = await import("node:fs");
        mkdirSync(dir, { recursive: true });
      }
      const db = new Database(path);
      db.run("PRAGMA journal_mode=WAL");
      db.run("PRAGMA busy_timeout=3000");
      for (const stmt of SCHEMA) db.run(stmt);
      // Migration for databases created before response-body capture existed:
      // CREATE TABLE IF NOT EXISTS won't add columns to an existing file, so
      // add them best-effort (duplicate-column errors are the no-op signal).
      try {
        db.run("ALTER TABLE traces ADD COLUMN response_body TEXT");
      } catch {
        /* column already exists */
      }
      try {
        db.run("ALTER TABLE traces ADD COLUMN response_body_truncated INTEGER NOT NULL DEFAULT 0");
      } catch {
        /* column already exists */
      }
      return new ObservatoryDb(db, path, opts);
    } catch {
      // An unopenable file must never take the app down — degrade to off.
      return new ObservatoryDb(null, path, opts);
    }
  }

  /** Queue one finalized request trace (+ its spans) for writing. */
  pushTrace(trace: RequestTrace): void {
    if (!this.db) return;
    this.traceQueue.push(trace);
    if (this.traceQueue.length >= 500) void this.flush();
  }

  /** Queue one structured log record for writing. */
  pushLog(record: LogRecord): void {
    if (!this.db) return;
    this.logQueue.push(record);
  }

  /** Queue one system sample for writing. */
  pushSample(sample: SystemSample): void {
    if (!this.db) return;
    this.sampleQueue.push(sample);
  }

  /** Begin background flushing + periodic pruning (idempotent). */
  start(): void {
    if (this.timer || !this.db) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  /** Write all queued rows inside a single transaction. */
  async flush(): Promise<void> {
    const db = this.db;
    if (!db) return;
    const traces = this.traceQueue.splice(0, this.traceQueue.length);
    const logs = this.logQueue.splice(0, this.logQueue.length);
    const samples = this.sampleQueue.splice(0, this.sampleQueue.length);
    if (traces.length === 0 && logs.length === 0 && samples.length === 0) return;
    try {
      db.run("BEGIN");
      for (const t of traces) this.writeTrace(t);
      for (const l of logs) this.writeLog(l);
      for (const s of samples) this.writeSample(s);
      db.run("COMMIT");
      this.written += traces.length + logs.length + samples.length;
      this.lastFlushAt = Date.now();
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      try {
        db.run("ROLLBACK");
      } catch {
        /* already rolled back / no tx */
      }
    }
    this.pruneIfNeeded();
  }

  private writeTrace(t: RequestTrace): void {
    const db = this.db;
    if (!db) return;
    db.run(
      `INSERT OR REPLACE INTO traces
       (id, ts, duration_ms, method, path, route, status, request_id, ip, error, error_stack,
        request_url, request_headers, request_body, response_headers, response_body,
        response_body_truncated, db_time_ms, db_count, span_count, stages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        t.id,
        t.ts,
        t.durationMs,
        t.method,
        t.path,
        t.route,
        t.status,
        t.requestId,
        t.ip,
        t.error,
        t.errorStack,
        t.request.url,
        JSON.stringify(t.request.headers),
        t.request.body,
        t.responseHeaders ? JSON.stringify(t.responseHeaders) : null,
        t.responseBody,
        t.responseBodyTruncated ? 1 : 0,
        t.dbTimeMs,
        t.dbCount,
        t.spans.length,
        JSON.stringify(t.stages),
      ],
    );
    db.run("DELETE FROM spans WHERE trace_id = ?", [t.id]);
    for (const s of t.spans) {
      db.run(
        `INSERT INTO spans
         (trace_id, sid, parent_id, name, kind, start_ms, duration_ms, open, error, origin, attrs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          t.id,
          s.id,
          s.parentId,
          s.name,
          s.kind,
          s.startMs,
          s.durationMs,
          s.open ? 1 : 0,
          s.error,
          s.origin,
          s.attrs ? JSON.stringify(s.attrs) : null,
        ],
      );
    }
  }

  private writeLog(l: LogRecord): void {
    const db = this.db;
    if (!db) return;
    db.run(
      `INSERT INTO logs (ts, level, message, attrs, trace_id, request_id, route, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        l.ts,
        l.level,
        l.message,
        l.attrs ? JSON.stringify(l.attrs) : null,
        l.traceId,
        l.requestId,
        l.route,
        l.source,
      ],
    );
  }

  private writeSample(s: SystemSample): void {
    const db = this.db;
    if (!db) return;
    db.run(
      `INSERT OR REPLACE INTO samples (ts, cpu_pct, rss_mib, heap_mib, event_loop_delay_ms, active_requests)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [s.ts, s.cpuPct, s.rssMiB, s.heapMiB, s.eventLoopDelayMs, s.activeRequests],
    );
  }

  private pruneIfNeeded(): void {
    const db = this.db;
    if (!db) return;
    const now = Date.now();
    if (now - this.lastPruneAt < this.options.pruneIntervalMs) return;
    this.lastPruneAt = now;
    const cutoff = now - this.options.maxAgeSec * 1000;
    try {
      db.run("DELETE FROM traces WHERE ts < ?", [cutoff]);
      db.run("DELETE FROM logs WHERE ts < ?", [cutoff]);
      db.run("DELETE FROM samples WHERE ts < ?", [cutoff]);
      db.run(
        `DELETE FROM traces WHERE id IN (
           SELECT id FROM traces ORDER BY ts DESC LIMIT -1 OFFSET ?
         )`,
        [this.options.maxRows],
      );
      db.run(`DELETE FROM spans WHERE trace_id NOT IN (SELECT id FROM traces)`);
      db.run(
        `DELETE FROM logs WHERE lid IN (
           SELECT lid FROM logs ORDER BY ts DESC LIMIT -1 OFFSET ?
         )`,
        [this.options.maxRows],
      );
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  /* ── history queries (cross-restart reads) ──────────────────────────── */

  /** Persisted trace summaries matching the query, newest first. */
  queryTraces(query: HistoryQuery = {}): HistoryTraceSummary[] {
    const db = this.db;
    if (!db) return [];
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.since !== undefined) {
      where.push("ts >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("ts <= ?");
      params.push(query.until);
    }
    if (query.method) {
      where.push("method = ?");
      params.push(query.method.toUpperCase());
    }
    if (query.status) {
      const family = /^([1-5])xx$/.exec(query.status);
      if (family?.[1]) {
        where.push("status BETWEEN ? AND ?");
        params.push(Number(family[1]) * 100, Number(family[1]) * 100 + 99);
      } else if (/^\d{3}$/.test(query.status)) {
        where.push("status = ?");
        params.push(Number(query.status));
      }
    }
    if (query.errorsOnly) where.push("error IS NOT NULL");
    if (query.minDurationMs !== undefined) {
      where.push("duration_ms >= ?");
      params.push(query.minDurationMs);
    }
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    // Substring filter over method+path+error is applied post-query (keeps
    // the SQL index-friendly); the fetch is padded to compensate.
    const fetchLimit = query.q?.trim() ? Math.min(2000, limit * 4) : limit;
    const sql = `SELECT * FROM traces${where.length ? ` WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY ts DESC LIMIT ?`;
    params.push(fetchLimit);
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
    const q = query.q?.trim().toLowerCase();
    const out: HistoryTraceSummary[] = [];
    for (const row of rows) {
      const summary = rowToSummary(row);
      if (
        q &&
        !`${summary.method} ${summary.path} ${summary.error ?? ""}`.toLowerCase().includes(q)
      ) {
        continue;
      }
      out.push(summary);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Rebuild one full persisted trace (with spans), or `undefined`. */
  getTrace(id: string): RequestTrace | undefined {
    const db = this.db;
    if (!db) return undefined;
    let rows: Array<Record<string, unknown>>;
    try {
      rows = db.query("SELECT * FROM traces WHERE id = ?").all(id) as Array<
        Record<string, unknown>
      >;
      if (rows.length === 0) return undefined;
      const spanRows = db
        .query("SELECT * FROM spans WHERE trace_id = ? ORDER BY sid")
        .all(id) as Array<Record<string, unknown>>;
      const traceRow = rows[0];
      return traceRow ? rowToTrace(traceRow, spanRows) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Persisted log records matching the query, newest first. */
  queryLogs(query: {
    minLevel?: string | undefined;
    q?: string | undefined;
    traceId?: string | undefined;
    since?: number | undefined;
    until?: number | undefined;
    limit?: number | undefined;
  }): LogRecord[] {
    const db = this.db;
    if (!db) return [];
    const ranks: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3 };
    const minRank = ranks[query.minLevel ?? "debug"] ?? 0;
    const levels = Object.keys(ranks).filter((l) => (ranks[l] as number) >= minRank);
    const where: string[] = [`level IN (${levels.map(() => "?").join(",")})`];
    const params: unknown[] = [...levels];
    if (query.since !== undefined) {
      where.push("ts >= ?");
      params.push(query.since);
    }
    if (query.until !== undefined) {
      where.push("ts <= ?");
      params.push(query.until);
    }
    if (query.traceId) {
      where.push("trace_id = ?");
      params.push(query.traceId);
    }
    if (query.q?.trim()) {
      where.push("message LIKE ?");
      params.push(`%${query.q.trim()}%`);
    }
    const sql = `SELECT * FROM logs WHERE ${where.join(" AND ")} ORDER BY ts DESC LIMIT ?`;
    params.push(Math.min(Math.max(query.limit ?? 200, 1), 1000));
    try {
      const rows = db.query(sql).all(...params) as Array<Record<string, unknown>>;
      return rows.map(rowToLog);
    } catch {
      return [];
    }
  }

  /** Persisted samples ascending over a time range (chart rehydration). */
  querySamples(since?: number, limit = 720): SystemSample[] {
    const db = this.db;
    if (!db) return [];
    try {
      const rows = (
        since !== undefined
          ? db
              .query("SELECT * FROM samples WHERE ts >= ? ORDER BY ts ASC LIMIT ?")
              .all(since, limit)
          : db.query("SELECT * FROM samples ORDER BY ts DESC LIMIT ?").all(limit)
      ) as Array<Record<string, unknown>>;
      const out = rows.map(sampleFromRow);
      return since === undefined ? out.reverse() : out;
    } catch {
      return [];
    }
  }

  /** Row counts (best effort — null when the table cannot be counted). */
  private count(table: "traces" | "logs" | "samples"): number | null {
    const db = this.db;
    if (!db) return null;
    try {
      const rows = db.query(`SELECT COUNT(*) AS n FROM ${table}`).all() as Array<{ n: number }>;
      return rows[0]?.n ?? 0;
    } catch {
      return null;
    }
  }

  /** Current sink status for `/api/meta` + `/api/diagnostics`. */
  status(): PersistStatus {
    const available = this.db !== null;
    const queued = this.traceQueue.length + this.logQueue.length + this.sampleQueue.length;
    return {
      enabled: true,
      path: this.filePath,
      available,
      queued,
      written: this.written,
      lastFlushAt: this.lastFlushAt,
      lastPruneAt: this.lastPruneAt,
      rows: available
        ? { traces: this.count("traces"), logs: this.count("logs"), samples: this.count("samples") }
        : { traces: null, logs: null, samples: null },
      error: this.lastError,
    };
  }

  /** Flush remaining rows, stop timers and close the file handle. */
  async close(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    try {
      this.db?.close();
    } catch {
      /* already closed */
    }
  }
}

/* ── row → wire-type mappers ───────────────────────────────────────────── */

const numOr = (v: unknown, fallback = 0): number => (typeof v === "number" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" ? v : null);

const jsonParseSafe = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== "string") return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

const rowToSummary = (row: Record<string, unknown>): HistoryTraceSummary => ({
  id: String(row.id ?? ""),
  ts: numOr(row.ts),
  method: String(row.method ?? ""),
  path: String(row.path ?? ""),
  route: strOrNull(row.route),
  status: numOr(row.status),
  durationMs: numOr(row.duration_ms),
  error: strOrNull(row.error),
  dbCount: numOr(row.db_count),
  dbTimeMs: numOr(row.db_time_ms),
  spanCount: numOr(row.span_count),
});

type SpanRow = Record<string, unknown>;

const rowToTrace = (row: SpanRow, spanRows: SpanRow[]): RequestTrace => ({
  id: String(row.id ?? ""),
  ts: numOr(row.ts),
  startedAtMs: 0,
  durationMs: numOr(row.duration_ms),
  method: String(row.method ?? ""),
  path: String(row.path ?? ""),
  route: strOrNull(row.route) ?? "",
  status: numOr(row.status),
  requestId: strOrNull(row.request_id) ?? "",
  ip: strOrNull(row.ip) ?? "",
  error: strOrNull(row.error),
  errorStack: strOrNull(row.error_stack),
  request: {
    method: String(row.method ?? ""),
    url: strOrNull(row.request_url) ?? "",
    headers: jsonParseSafe<Record<string, string>>(row.request_headers, {}),
    body: strOrNull(row.request_body),
  },
  responseHeaders: jsonParseSafe<Record<string, string> | null>(row.response_headers, null),
  responseBody: strOrNull(row.response_body),
  responseBodyTruncated: numOr(row.response_body_truncated) === 1,
  spans: spanRows.map((s) => ({
    id: numOr(s.sid),
    parentId: s.parent_id === null || s.parent_id === undefined ? null : numOr(s.parent_id),
    name: String(s.name ?? ""),
    kind: String(s.kind ?? "custom") as RequestTrace["spans"][number]["kind"],
    startMs: numOr(s.start_ms),
    durationMs: numOr(s.duration_ms),
    open: numOr(s.open) === 1,
    error: strOrNull(s.error),
    attrs: jsonParseSafe<Record<string, unknown> | null>(s.attrs, null),
    origin: strOrNull(s.origin),
  })),
  dbTimeMs: numOr(row.db_time_ms),
  dbCount: numOr(row.db_count),
  stages: jsonParseSafe<string[]>(row.stages, []),
});

const rowToLog = (row: SpanRow): LogRecord => ({
  id: numOr(row.lid),
  ts: numOr(row.ts),
  level: String(row.level ?? "info") as LogRecord["level"],
  message: String(row.message ?? ""),
  attrs: jsonParseSafe<Record<string, unknown> | null>(row.attrs, null),
  traceId: strOrNull(row.trace_id),
  requestId: strOrNull(row.request_id),
  route: strOrNull(row.route),
  source: strOrNull(row.source) ?? "app",
});

const sampleFromRow = (row: SpanRow): SystemSample => ({
  ts: numOr(row.ts),
  cpuPct: numOr(row.cpu_pct),
  rssMiB: numOr(row.rss_mib),
  heapMiB: numOr(row.heap_mib),
  eventLoopDelayMs: numOr(row.event_loop_delay_ms),
  activeRequests: numOr(row.active_requests),
});
