/**
 * @fileoverview Debugbar API surface types — the `ctx.debug` runtime API and
 * the unified events-panel buffer (NATS pub/sub + nova realtime).
 *
 * Extracted from the pre-split `debug/types.ts` (move-only); the other three
 * domain files are `./trace`, `./knowledge` and `./observability`, all
 * re-exported by `./index`.
 */

import type { LogLevel } from "./observability";
import type { DebugSpanHandle, SpanAttrs, SpanKind } from "./trace";

/** Per-request API exposed as `ctx.debug` (no-op when the plugin is absent). */
export interface DebugApi {
  /**
   * Run `fn` inside an auto-timed span of the given kind. The span is recorded
   * even when `fn` throws (as an error span) and the error is rethrown.
   */
  span<T>(name: string, kind: SpanKind, fn: () => T | Promise<T>, attrs?: SpanAttrs): Promise<T>;
  /** Start a manual span; end it with the returned handle (for interleaved work). */
  start(name: string, kind?: SpanKind, attrs?: SpanAttrs): DebugSpanHandle;
  /**
   * Record a database query (timed automatically when `fn` is provided).
   * `params` is WHAT WAS SENT — positional SQL binds (array), a Mongo
   * filter/options document (object) or any JSON-safe payload; it is stored
   * verbatim on the span and rendered by the dashboard's Queries tab.
   */
  query(sql: string, params?: unknown, fn?: () => unknown | Promise<unknown>): Promise<unknown>;
  /**
   * Record a completed cache operation. The span is always closed
   * immediately; when {@link cache.durationMs} is provided it becomes the
   * span's waterfall duration (caller-measured), otherwise ~0ms.
   */
  cache(hit: boolean, label: string, durationMs?: number, attrs?: SpanAttrs): void;
  /** Time an outbound HTTP call and record it as an `http` span. */
  http(label: string, fn: () => Response | Promise<Response>): Promise<Response>;
  /** Attach an instantaneous event/note to the trace (zero duration). */
  event(name: string, attrs?: SpanAttrs): void;
  /** Record an error against this request (surfaces in the errors view). */
  error(err: unknown, attrs?: SpanAttrs): void;
  /**
   * Record a structured observatory log line, correlated to this request.
   * No-op when no log store is installed (debugbar absent / debug off).
   */
  log(level: LogLevel, message: string, attrs?: SpanAttrs): void;
}

/* ============================================================================
 * Events panel — the unified event buffer (NATS pub/sub + nova/WS realtime).
 *
 * The debugbar's Events view is a single buffer that interleaves two
 * transports so you can see, side by side, what your app SENT and what it
 * RECEIVED over the wire:
 *   - `nats` — messages published / received over the NATS bus
 *     (`NatsEventTracker`, tracked push-style into its ring).
 *   - `nova` — events that fired in the app's typed realtime transport
 *     (`@ignex/nova`): server→client emits/publishes, client→server inbound,
 *     cluster-sync and NATS-bridge inbound. Read from nova's own trace ring
 *     via the `data.nova` probe.
 *
 * Contract served by `GET /api/events` and rendered by `ui/views/events.tsx`.
 * ==========================================================================*/

/** Transport an event-buffer row came from. */
export type DebugEventSource = "nats" | "nova";

/** One row in the unified Events panel buffer. */
export interface DebugEventRow {
  /** Stable id within the buffer (`ev-…` for nats, `nv-<seq>` for nova). */
  readonly id: string;
  /** Epoch ms when the event was recorded. */
  readonly ts: number;
  readonly source: DebugEventSource;
  /** `out` = this process sent it, `in` = this process received it. */
  readonly direction: "in" | "out";
  /**
   * Precise kind behind the direction pill:
   * nats → `publish` | `message`; nova → `publish` | `emit` | `client`
   * (received from a WS client) | `remote` | `bridge`.
   */
  readonly kind: string;
  /** Subject (nats) or wire event name (nova), e.g. `orders.created`. */
  readonly name: string;
  /** Nova target key (user/topic/group/client id) when addressed. */
  readonly key?: string;
  /** Truncated JSON payload preview (`""` when capture is off or empty). */
  readonly payload: string;
  /** Wire size in bytes. */
  readonly size: number;
  /** Error message when the send/recv failed, else null. */
  readonly error: string | null;
}

/** Per-source summary for the unified Events panel header. */
export interface DebugEventSourceInfo {
  /** True when the source is wired and producing data. */
  readonly present: boolean;
  /** Human label: `NATS bus` | `Nova realtime (WS)`. */
  readonly label: string;
  /** NATS connection state (nats only). */
  readonly connected?: boolean;
  readonly status?: string;
  /** Retained rows in the buffer/ring (≤ capacity). */
  readonly size: number;
  /** Rows written since the buffer started. */
  readonly total: number;
  readonly in: number;
  readonly out: number;
  readonly errors: number;
  readonly bytes: number;
  /** Per-subject (nats) / per-event (nova) counts over the window. */
  readonly byName: Record<string, number>;
  /**
   * Nova only: whether the ring is capturing truncated JSON payload previews
   * (`undefined` for nats, which always stores payloads).
   */
  readonly captures?: boolean;
  /** Present when the source could not be probed: guidance text. */
  readonly hint?: string;
}

/** `GET /api/events` — the unified Events panel payload. */
export interface DebugEventsPayload {
  /** True when at least one source is wired (NATS and/or nova). */
  readonly enabled: boolean;
  /** Shown when NOTHING is wired: how to turn on either source. */
  readonly hint?: string;
  readonly sources: {
    readonly nats: DebugEventSourceInfo | null;
    readonly nova: DebugEventSourceInfo | null;
  };
  /** Interleaved rows, newest first, capped by `limit`. */
  readonly recent: DebugEventRow[];
}
