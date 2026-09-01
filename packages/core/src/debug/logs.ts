/**
 * @fileoverview LogStore — structured log capture for the observatory.
 *
 * A bounded ring of {@link LogRecord}s with level/search/time/trace filters,
 * a process-wide default recorder installed by the `debugbar()` plugin, ALS
 * correlation (`debugLog()` inside a request attaches its trace id) and an
 * opt-in console interceptor that mirrors `console.*` calls into the store
 * while still passing them through to the real terminal.
 */

import { currentTrace } from "./tracer";
import type { LogLevel, LogQuery, LogRecord, LogStats, SpanAttrs } from "./types";

/** Ordered severities — index doubles as the rank for min-level filtering. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Options for {@link LogStore}. */
export interface LogStoreOptions {
  /** Maximum records retained (ring buffer). Default 2000. */
  readonly maxRecords?: number;
  /**
   * Mutation notification (push/clear) — used by the debugbar's live-stream
   * revision counters; called after the mutation completes.
   */
  readonly onNotify?: () => void;
}

/**
 * Bounded structured-log ring buffer. All accessors are synchronous so the
 * dashboard APIs serve inline; persistence is wired via {@link setSink}.
 */
export class LogStore {
  readonly maxRecords: number;
  private readonly records: LogRecord[] = [];
  private nextId = 1;
  private sink: ((record: LogRecord) => void) | null = null;

  private readonly onNotify: (() => void) | null;

  constructor(options: LogStoreOptions = {}) {
    this.maxRecords = options.maxRecords ?? 2000;
    this.onNotify = options.onNotify ?? null;
  }

  /**
   * Attach a per-record sink (e.g. the SQLite observatory queue). Called
   * synchronously after each record is stored; a throwing sink is ignored.
   */
  setSink(sink: (record: LogRecord) => void): void {
    this.sink = sink;
  }

  /** Store one record (drops the oldest when full) and return it. */
  push(input: {
    level: LogLevel;
    message: string;
    attrs?: SpanAttrs | null;
    traceId?: string | null;
    requestId?: string | null;
    route?: string | null;
    source?: string;
  }): LogRecord {
    const record: LogRecord = {
      id: this.nextId++,
      ts: Date.now(),
      level: input.level,
      message: input.message,
      attrs: (input.attrs ?? null) as LogRecord["attrs"],
      traceId: input.traceId ?? null,
      requestId: input.requestId ?? null,
      route: input.route ?? null,
      source: input.source ?? "app",
    };
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.shift();
    try {
      this.sink?.(record);
    } catch {
      // a broken persistence sink must never break logging
    }
    this.onNotify?.();
    return record;
  }

  /** Filtered records, newest first. See {@link LogQuery} for the shape. */
  list(query: LogQuery = {}): LogRecord[] {
    const limit = Math.min(Math.max(query.limit ?? 200, 1), 1000);
    const minRank = LEVEL_RANK[query.minLevel ?? "debug"];
    const q = query.q?.trim().toLowerCase();
    const out: LogRecord[] = [];
    for (let i = this.records.length - 1; i >= 0 && out.length < limit; i--) {
      const r = this.records[i];
      if (r === undefined) continue;
      if (LEVEL_RANK[r.level] < minRank) continue;
      if (query.traceId && r.traceId !== query.traceId) continue;
      if (query.since !== undefined && r.ts < query.since) continue;
      if (query.until !== undefined && r.ts > query.until) continue;
      if (q && r.message.toLowerCase().indexOf(q) === -1) continue;
      out.push(r);
    }
    return out;
  }

  /** Per-level counts over retained records. */
  stats(): LogStats {
    const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const r of this.records) counts[r.level]++;
    return { total: this.records.length, ...counts };
  }

  /**
   * One record by its monotonic id (the dashboard's log-detail endpoint),
   * or `undefined` when the id was never issued / has rotated out of the ring.
   */
  getById(id: number): LogRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r !== undefined && r.id === id) return r;
    }
    return undefined;
  }

  /** Drop everything. */
  clear(): void {
    this.records.length = 0;
    this.onNotify?.();
  }

  get size(): number {
    return this.records.length;
  }
}

/* ============================================================================
 * Process-wide default recorder + free helpers
 * ==========================================================================*/

let globalStore: LogStore | null = null;

/**
 * Install the process-wide log store used by {@link debugLog} and console
 * capture. Idempotent: the latest installation wins.
 *
 * @returns The installed store (same reference).
 */
export const installLogStore = (store: LogStore): LogStore => {
  globalStore = store;
  return store;
};

/** Detach the process-wide store (plugin close / tests). */
export const uninstallLogStore = (): void => {
  globalStore = null;
};

/** The active process-wide store, or `undefined` when none is installed. */
export const activeLogStore = (): LogStore | undefined => globalStore ?? undefined;

/**
 * Record a structured log line against the current request's trace (ALS),
 * or uncorrelated when called outside any request.
 *
 * No-op when no observatory log store is installed (production without the
 * debugbar plugin), which keeps call sites safe everywhere.
 */
export const debugLog = (
  level: LogLevel,
  message: string,
  attrs?: Record<string, unknown>,
): void => {
  const store = globalStore;
  if (!store) return;
  const trace = currentTrace();
  store.push({
    level,
    message,
    attrs: attrs ?? null,
    traceId: trace?.id ?? null,
    // Plain readonly fields — never call trace.toJSON() here: it clones every
    // span of the request and this runs per log line / console call.
    requestId: trace?.requestId ?? null,
    route: trace?.route ?? null,
    source: "app",
  });
};

/* ============================================================================
 * Console interception (opt-in)
 * ==========================================================================*/

type ConsoleFn = (...args: unknown[]) => void;

/** Flatten console args to one human-readable line (objects JSON-stringified). */
const flattenArgs = (args: unknown[]): string =>
  args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return `${a.name}: ${a.message}`;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

/**
 * Intercept `console.debug/log/info/warn/error` and mirror every call into
 * `store` (source `"console"`) while still forwarding to the original fns.
 * Reentrancy-guarded so a logger writing through console cannot recurse.
 *
 * @returns A restore function that puts the original console methods back.
 */
export const captureConsole = (store: LogStore): (() => void) => {
  const c = console as unknown as Record<string, ConsoleFn>;
  const original: Record<string, ConsoleFn> = {};
  let inside = false;

  const wrap = (key: string, level: LogLevel): void => {
    const fn = c[key];
    if (typeof fn !== "function") return;
    original[key] = fn;
    c[key] = (...args: unknown[]) => {
      if (!inside) {
        inside = true;
        try {
          const trace = currentTrace();
          store.push({
            level,
            message: flattenArgs(args).slice(0, 2000),
            attrs: null,
            traceId: trace?.id ?? null,
            // Readonly fields directly — see debugLog (no toJSON clone).
            requestId: trace?.requestId ?? null,
            route: trace?.route ?? null,
            source: "console",
          });
        } catch {
          // never let capture itself break the app's logging
        } finally {
          inside = false;
        }
      }
      fn.apply(console, args);
    };
  };

  wrap("debug", "debug");
  wrap("log", "info");
  wrap("info", "info");
  wrap("warn", "warn");
  wrap("error", "error");

  return () => {
    for (const [key, fn] of Object.entries(original)) c[key] = fn;
  };
};
