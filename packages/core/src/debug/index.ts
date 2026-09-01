/**
 * @fileoverview Debug toolkit — the developer dashboard's runtime core.
 *
 * Public surface of `@ignex/core/debug`: free-function tracing helpers that
 * work anywhere in a request's async chain (ALS-propagated), the trace/store
 * types, the system profiler, the observatory (structured logs, metrics with
 * Prometheus exposition, leak diagnostics, SQLite history) and the KT
 * knowledge builder. The dashboard itself is served by the `debugbar()`
 * plugin (`@ignex/core`).
 */

export {
  createDebugApi,
  debugCache,
  debugError,
  debugEvent,
  debugQuery,
  debugSpan,
  NOOP_DEBUG_API,
} from "./api";
export {
  ClientRegistry,
  type ClientRegistryOptions,
  type GitTagInfo,
  type PublishedClient,
} from "./clients";
export {
  buildAppKnowledge,
  buildRouteFileIndex,
  formatKnowledgeMarkdown,
  scanDocsInventory,
  scanProjectAreas,
  summarizeDbActivity,
} from "./kt";
export {
  analyzeSamples,
  forceGc,
  type LeakAnalysisOptions,
  linearTrend,
} from "./leaks";
export {
  activeLogStore,
  captureConsole,
  debugLog,
  installLogStore,
  LogStore,
  type LogStoreOptions,
  uninstallLogStore,
} from "./logs";
export {
  DEFAULT_DURATION_BUCKETS_MS,
  MetricsRegistry,
  type MetricsRegistryOptions,
} from "./metrics";
export {
  instrumentMongoClient,
  type MongoCommandEvent,
  type MongoFailedEvent,
  type MongoSucceededEvent,
  type MonitorableMongoClient,
} from "./mongo";
export {
  NatsConnection,
  type NatsEvent,
  type NatsEventStats,
  type NatsEventSummary,
  NatsEventTracker,
  type NatsStatus,
  type NatsTrackerOptions,
} from "./nats-tracker";
export {
  ObservatoryDb,
  type ObservatoryDbOptions,
} from "./persist";
export {
  buildDecodedMappings,
  createSourceFrameResolver,
  type DecodedMappings,
  decodeVlq,
  type FrameLocation,
  lookupMapping,
  type MappingSegment,
  parseFrameLocation,
  type RawSourceMap,
  type SourceFrameResolver,
  type SourceFrameResolverOptions,
  setSharedSourceFrames,
  sharedSourceFrames,
} from "./sourcemaps";
export { TraceStore, type TraceStoreOptions, type TraceSummary } from "./store";
export {
  SystemProfiler,
  type SystemProfilerOptions,
  scheduleEventLoopProbe,
} from "./system";
export {
  beginTrace,
  captureRedactedHeaders,
  currentTrace,
  currentTraceContext,
  debugStageEnd,
  enterTraceContext,
  isRedactedHeader,
  isTracingEnabled,
  redactHeaderValue,
  redactRequestTrace,
  setTracingEnabled,
  Trace,
} from "./tracer";
export type {
  AiDebugSummary,
  AppKnowledge,
  AppStateSnapshot,
  CapturedRequest,
  DebugApi,
  DebugSpanHandle,
  DiagnosticsReport,
  HistogramSnapshot,
  HistoryQuery,
  HistoryTraceSummary,
  KnowledgeOptions,
  KnowledgePlugin,
  KnowledgeRoute,
  KnowledgeSdk,
  KnowledgeStage,
  LeakFinding,
  LogLevel,
  LogQuery,
  LogRecord,
  LogStats,
  MetricsSnapshot,
  PersistStatus,
  RequestTrace,
  RouteMetrics,
  Span,
  SpanAttrs,
  SpanKind,
  SystemSample,
  SystemStats,
  TraceDetail,
} from "./types";
