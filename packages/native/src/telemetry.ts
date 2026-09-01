/**
 * @fileoverview Native-degradation telemetry — a tiny observable sink for
 * every "native could not do its job" event.
 *
 * Historically these events were silent: an addon fault downgraded the
 * security pipeline to pass-through, a load failure quietly switched to JS,
 * and `passwordVerify` returned `false` for argon2id hashes with zero
 * diagnostics. That is fail-OPEN behavior nobody can see in production.
 *
 * This module makes every degradation VISIBLE:
 * - {@link reportDegradation} — call sites emit one event per op (rate-limited
 *   to once per op per process so a hot path cannot spam logs);
 * - {@link setNativeTelemetrySink} — apps plug their metrics/log pipeline in;
 * - default sink is `console.error` (once per op).
 *
 * Zero dependencies, never throws, safe to call on any hot path.
 */

/** The kind of native degradation being reported. */
export type DegradationKind =
  /** A native call failed at runtime; the JS path (or pass-through) took over. */
  | "call-failed"
  /** The addon/FFI surface is missing entirely; a fallback owns the op. */
  | "surface-missing"
  /** A bind-time self-test failed; the op degrades to its fallback. */
  | "self-test-failed"
  /** An operation cannot be reproduced by any available backend (fail closed). */
  | "unsupported";

/** One degradation event. */
export interface DegradationEvent {
  /** What went wrong (stable machine tag). */
  readonly kind: DegradationKind;
  /** The affected operation (SELECTION op name or pipeline stage). */
  readonly op: string;
  /** Human-readable detail; safe to log (never includes secrets). */
  readonly message: string;
}

/** A telemetry sink receives every degradation event. */
export type TelemetrySink = (event: DegradationEvent) => void;

const warnedOps = new Set<string>();
let sink: TelemetrySink | null = null;

/**
 * Per-op degradation counters — incremented on EVERY event, independent of
 * any installed sink. The default console sink rate-limits to one line per op,
 * which made a flapping op invisible after its first failure; these counters
 * keep the full magnitude observable (`ignex_native_degradations_total{op}`
 * semantics for metrics pipelines). Read via {@link degradationCounts}.
 */
const counters = new Map<string, number>();

/**
 * Snapshot of the per-op degradation counters (op → total events this
 * process). Copy — mutation-safe for polling sinks.
 */
export const degradationCounts = (): Readonly<Record<string, number>> =>
  Object.fromEntries(counters);

/** Total degradation events across all ops this process. */
export const degradationTotal = (): number => {
  let total = 0;
  for (const v of counters.values()) total += v;
  return total;
};

/**
 * Install an app-level telemetry sink (metrics counters, structured logs).
 * Pass `null` to revert to the default console sink.
 */
export const setNativeTelemetrySink = (next: TelemetrySink | null): void => {
  sink = next;
};

/** The default sink: one loud `console.error` per op per process. */
const defaultSink = (event: DegradationEvent): void => {
  if (warnedOps.has(event.op)) return;
  warnedOps.add(event.op);
  console.error(
    `[ignex-native] degraded (${event.kind}) op=${event.op}: ${event.message} ` +
      `(reported once per op — ${counters.get(event.op) ?? 1} occurrences so far, ` +
      `polled via degradationCounts(); set IGNEX_NATIVE=off to pin pure-TS and silence)`,
  );
};

/**
 * Report a native degradation. Never throws; the count is ALWAYS recorded
 * (even when a custom sink swallows it), subsequent calls for the same op are
 * rate-limited in the default console sink so hot paths cannot flood logs.
 */
export const reportDegradation = (kind: DegradationKind, op: string, message: string): void => {
  counters.set(op, (counters.get(op) ?? 0) + 1);
  const event: DegradationEvent = { kind, op, message };
  try {
    if (sink) sink(event);
    else defaultSink(event);
  } catch {
    // A broken telemetry sink must never break the request path.
  }
};

/** Test hook: clear the once-per-op rate limiter AND the counters. */
export const resetTelemetryRateLimit = (): void => {
  warnedOps.clear();
  counters.clear();
};
