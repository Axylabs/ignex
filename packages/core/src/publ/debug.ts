/**
 * @fileoverview Public sub-barrel: debug + observatory primitives re-exported
 * from the `@ignex/core` entry (split from the barrel `src/index.ts` by section
 * banner — move-only; `export` statements verbatim).
 */

// `debugQuery`/`debugSpan` precede the debug banner in the source barrel —
// kept first here to preserve order.
export { debugQuery, debugSpan } from "../debug/api";
// ── debug (developer dashboard primitives) ──────────────────────
export { ClientRegistry, type PublishedClient } from "../debug/clients";
export { analyzeSamples, forceGc, linearTrend } from "../debug/leaks";
export {
  activeLogStore,
  captureConsole,
  debugLog,
  installLogStore,
  LogStore,
  uninstallLogStore,
} from "../debug/logs";
export { MetricsRegistry } from "../debug/metrics";
export { NatsEventTracker } from "../debug/nats-tracker";
export { ObservatoryDb } from "../debug/persist";
export { TraceStore } from "../debug/store";
export { SystemProfiler } from "../debug/system";
export {
  currentTrace,
  isTracingEnabled,
} from "../debug/tracer";
export type {
  AiDebugSummary,
  AppStateSnapshot,
  DebugApi,
  DebugSpanHandle,
  DiagnosticsReport,
  HistoryQuery,
  HistoryTraceSummary,
  LeakFinding,
  LogLevel,
  LogQuery,
  LogRecord,
  LogStats,
  MetricsSnapshot as ObservatoryMetricsSnapshot,
  PersistStatus,
  RequestTrace,
  RouteMetrics,
  Span,
  SpanAttrs,
  SpanKind,
  SystemSample,
  SystemStats,
} from "../debug/types";
