/**
 * @fileoverview Debugbar shared types barrel — trace, api, knowledge and
 * observability domain surfaces.
 *
 * Replaces the pre-split `debug/types.ts` (move-only). Importers keep using
 * `debug/types` (or `../src/debug/types.js` from tests); each domain file also
 * imports its cross-references directly so the barrel is not a hard hub.
 */

export type {
  DebugApi,
  DebugEventRow,
  DebugEventSourceInfo,
  DebugEventsPayload,
} from "./api";
export type {
  AiDebugSummary,
  AppKnowledge,
  KnowledgeArea,
  KnowledgeDbAction,
  KnowledgeDoc,
  KnowledgeOptions,
  KnowledgePlugin,
  KnowledgeRoute,
  KnowledgeSdk,
  KnowledgeStage,
} from "./knowledge";
export type {
  AppStateSnapshot,
  DiagnosticsReport,
  HistogramSnapshot,
  HistoryQuery,
  HistoryTraceSummary,
  LeakFinding,
  LogLevel,
  LogQuery,
  LogRecord,
  LogStats,
  MetricsSnapshot,
  PersistStatus,
  RouteMetrics,
} from "./observability";
export type {
  CapturedRequest,
  DebugSpanHandle,
  RequestTrace,
  Span,
  SpanAttrs,
  SpanKind,
  SystemSample,
  SystemStats,
  TraceDetail,
} from "./trace";
