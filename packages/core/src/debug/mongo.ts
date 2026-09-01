/**
 * @fileoverview MongoDB wire-level instrumentation for the debugger.
 *
 * {@link instrumentMongoClient} hooks a `mongodb` driver `MongoClient`'s
 * command-monitoring events (`commandStarted` / `commandSucceeded` /
 * `commandFailed`) and records every actual database round-trip as a `db`
 * span in the active request trace — including WHAT WAS SENT (the full wire
 * command: filter, projection, update documents, pipeline) and WHAT WAS
 * RECEIVED (the driver reply preview), plus the driver-reported duration.
 *
 * This complements ORM-level spans (e.g. `gigs.find` from @ignex/ninox):
 * when a command fires inside an open `db` span it becomes a child of it
 * (`find app.gigs` under `gigs.find`), so the waterfall shows both the
 * logical operation and the exact wire round-trips beneath it. Nested db
 * spans are excluded from the dbCount/dbTimeMs aggregates by the tracer,
 * so totals stay truthful. Commands fired outside any traced request
 * (heartbeats, production traffic) cost one ALS lookup and nothing else.
 *
 * No `mongodb` import here on purpose: the client surface is typed
 * structurally so core stays dependency-free.
 */

import { currentTrace, type Trace } from "./tracer";
import type { Span } from "./types";

/** Preview cap for captured wire payloads (same budget as query results — big
 * enough that a normal find/aggregate reply survives intact). */
const WIRE_PREVIEW_CHARS = 32_768;

/**
 * JSON-preview helper for wire payloads: capped so a huge cursor reply cannot
 * balloon the trace ring. Returns `undefined` for undefined input and for
 * values that fail to serialize (circularity etc.) — callers store the attr
 * only when present.
 */
const previewJson = (value: unknown): string | undefined => {
  if (value === undefined) return undefined;
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > WIRE_PREVIEW_CHARS ? `${text.slice(0, WIRE_PREVIEW_CHARS)}…` : text;
};

/** Structural subset of a driver command-monitoring event. */
export interface MongoCommandEvent {
  /** Driver-issued correlation id — pairs started with succeeded/failed. */
  readonly requestId: number;
  /** Wire operation name (`find`, `insert`, `aggregate`, `getMore`, …). */
  readonly commandName: string;
  /** The full command document as placed on the wire (WHAT WAS SENT). */
  readonly command?: Record<string, unknown>;
  /** Logical database name the command targets. */
  readonly databaseName?: string;
}

/** A successful round-trip: adds the driver-reported duration + reply. */
export interface MongoSucceededEvent extends MongoCommandEvent {
  /** Round-trip duration in milliseconds as measured by the driver. */
  readonly duration?: number;
  /** The server reply (WHAT WAS RECEIVED). */
  readonly reply?: unknown;
}

/** A failed round-trip: adds the driver-reported failure instead of a reply. */
export interface MongoFailedEvent extends MongoCommandEvent {
  /** Round-trip duration in milliseconds as measured by the driver. */
  readonly duration?: number;
  /** The failure (Error or plain object). */
  readonly failure?: unknown;
}

/**
 * Structural subset of the driver's `MongoClient` needed for monitoring:
 * event subscription plus the `monitorCommands` switch. Satisfied by the real
 * client (`mongodb` ≥ 4) and by test doubles; no import required.
 */
export interface MonitorableMongoClient {
  /** Subscribe to a command-monitoring event. */
  on(event: "commandStarted", listener: (ev: MongoCommandEvent) => void): unknown;
  on(event: "commandSucceeded", listener: (ev: MongoSucceededEvent) => void): unknown;
  on(event: "commandFailed", listener: (ev: MongoFailedEvent) => void): unknown;
  /** Unsubscribe (dispose support). Optional: older drivers may omit it. */
  off?(event: "commandStarted", listener: (ev: MongoCommandEvent) => void): unknown;
  off?(event: "commandSucceeded", listener: (ev: MongoSucceededEvent) => void): unknown;
  off?(event: "commandFailed", listener: (ev: MongoFailedEvent) => void): unknown;
  /** Must be true for the driver to emit command events at all. */
  monitorCommands?: boolean;
}

/** In-flight bookkeeping for one wire command (started, awaiting settle). */
interface PendingCommand {
  readonly trace: Trace;
  readonly span: Span;
  readonly sentPreview: string | undefined;
  readonly perfStart: number;
}

/** Hard cap on in-flight tracked commands — guards against lost settle
 * events (dropped connections) ballooning the map. Oldest entries evicted. */
const MAX_PENDING = 512;

/**
 * Derive the span label for a command: `<op> <db>.<collection>` when the
 * collection is derivable (the driver places it at the top-level key named
 * after the op for most commands), else just the op name.
 */
const spanLabel = (ev: MongoCommandEvent): string => {
  const cmd = ev.command;
  if (cmd !== undefined && typeof cmd === "object") {
    const target = cmd[ev.commandName];
    if (typeof target === "string")
      return `${ev.commandName} ${ev.databaseName ?? ""}.${target}`.trimEnd();
    if (typeof cmd.collection === "string") {
      return `${ev.commandName} ${ev.databaseName ?? ""}.${cmd.collection}`.trimEnd();
    }
  }
  return ev.databaseName !== undefined ? `${ev.commandName} ${ev.databaseName}` : ev.commandName;
};

/** Best-effort namespace string for the span attrs (`db.collection`). */
const namespaceOf = (ev: MongoCommandEvent): string | undefined => {
  const cmd = ev.command;
  if (cmd !== undefined && typeof cmd === "object") {
    const target = cmd[ev.commandName];
    if (typeof target === "string") return `${ev.databaseName ?? ""}.${target}`;
  }
  return ev.databaseName;
};

/**
 * Hook a Mongo client's command monitor into the debug tracer. Every wire
 * round-trip that happens while a request trace is active is recorded as a
 * `db` span with `sent` (full command preview), `reply`/failure preview and
 * `ms` (driver-reported duration) attrs; commands outside a trace are ignored.
 *
 * Call this BEFORE opening connections: the driver's pooled connections
 * snapshot `monitorCommands` when they are constructed, so a pool that was
 * already warm when this runs stays silent until its connections are replaced.
 * For an app-level ORM whose calls all funnel through one accessor, wrapping
 * THAT boundary with `debugQuery()` is simpler and needs no driver internals.
 *
 * Idempotent per client instance.
 *
 * @returns A dispose function that unsubscribes the listeners and switches
 * `monitorCommands` back off (idempotent).
 */
export const instrumentMongoClient = (client: MonitorableMongoClient): { dispose(): void } => {
  if (client.monitorCommands) return { dispose: () => {} };
  client.monitorCommands = true;

  const pending = new Map<number, PendingCommand>();

  const dropOldest = (): void => {
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  };

  const onStarted = (ev: MongoCommandEvent): void => {
    const trace = currentTrace();
    if (!trace) return; // untraced context (heartbeat / production) — free pass
    if (pending.size >= MAX_PENDING) dropOldest();
    const span = trace.start(spanLabel(ev), "db", {
      ns: namespaceOf(ev),
      op: ev.commandName,
    });
    pending.set(ev.requestId, {
      trace,
      span,
      sentPreview: previewJson(ev.command),
      perfStart: performance.now(),
    });
  };

  const onSucceeded = (ev: MongoSucceededEvent): void => {
    const entry = pending.get(ev.requestId);
    if (!entry) return;
    pending.delete(ev.requestId);
    const replyPreview = previewJson(ev.reply);
    entry.trace.end(entry.span, {
      ms: Math.round((ev.duration ?? performance.now() - entry.perfStart) * 100) / 100,
      ...(entry.sentPreview !== undefined ? { sent: entry.sentPreview } : {}),
      ...(replyPreview !== undefined ? { reply: replyPreview } : {}),
    });
  };

  const onFailed = (ev: MongoFailedEvent): void => {
    const entry = pending.get(ev.requestId);
    if (!entry) return;
    pending.delete(ev.requestId);
    const ms = ev.duration ?? performance.now() - entry.perfStart;
    entry.trace.end(entry.span, {
      ms: Math.round(ms * 100) / 100,
      ...(entry.sentPreview !== undefined ? { sent: entry.sentPreview } : {}),
    });
    entry.trace.fail(
      entry.span,
      ev.failure instanceof Error ? ev.failure : new Error(JSON.stringify(ev.failure ?? "unknown")),
    );
  };

  client.on("commandStarted", onStarted);
  client.on("commandSucceeded", onSucceeded);
  client.on("commandFailed", onFailed);

  return {
    dispose() {
      client.off?.("commandStarted", onStarted);
      client.off?.("commandSucceeded", onSucceeded);
      client.off?.("commandFailed", onFailed);
      client.monitorCommands = false;
    },
  };
};
