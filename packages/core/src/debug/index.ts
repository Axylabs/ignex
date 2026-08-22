/**
 * @fileoverview Debug toolkit — the developer dashboard's runtime core.
 *
 * Public surface of `@ignex/core/debug`: free-function tracing helpers that
 * work anywhere in a request's async chain (ALS-propagated), the trace/store
 * types, the system profiler and the KT knowledge builder. The dashboard
 * itself is served by the `debugbar()` plugin (`@ignex/core`).
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
  formatKnowledgeMarkdown,
} from "./kt";
export {
  NatsConnection,
  type NatsEvent,
  type NatsEventStats,
  type NatsEventSummary,
  NatsEventTracker,
  type NatsStatus,
  type NatsTrackerOptions,
} from "./nats-tracker";
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
  CapturedRequest,
  DebugApi,
  DebugSpanHandle,
  KnowledgeOptions,
  KnowledgePlugin,
  KnowledgeRoute,
  KnowledgeSdk,
  KnowledgeStage,
  RequestTrace,
  Span,
  SpanAttrs,
  SpanKind,
  SystemSample,
  SystemStats,
} from "./types";
