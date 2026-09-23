/**
 * @fileoverview `GET /api/ai/summary` — the compact, token-cheap snapshot an AI
 * agent (through the MCP debugger) fetches first.
 *
 * Split out of `app-panels.ts` (which keeps the panel handlers) because this is
 * the ONE document that must answer "what is broken, and why" in a few hundred
 * tokens: every recent failure carries its **fault classification** — code,
 * origin, kind, service, the retryable verdict, the innermost cause and the
 * operator hints — plus a fault-code histogram. An agent therefore knows the
 * root cause before it decides which trace to open, instead of reading eight
 * raw error strings and guessing.
 */

import type { NovaEventTrace } from "../../../plugins/nova";
import { formatCause } from "../../fault-capture";
import { analyzeSamples } from "../../leaks";
import { json } from "../../respond";
import type {
  AiDebugSummary,
  AiRecentError,
  AppKnowledge,
  RequestTrace,
  TraceFault,
} from "../../types";
import type { HandlerDeps } from "../types";
import { clientProbePaths, novaHandle } from "./app-panels";

/** The handler needs only the knowledge half of the KT data. */
type KnowledgeProbe = () => Promise<{ knowledge: AppKnowledge }>;

/** Cap on the hints copied into a row — the first one is the likely fix. */
const MAX_HINTS = 2;

/**
 * Fault facts for one summary row. Every field is optional and spread
 * conditionally, so a failed request with no classification stays a compact
 * row rather than a row full of nulls.
 */
const faultFacts = (fault: TraceFault | null | undefined): Partial<AiRecentError> => {
  if (fault === null || fault === undefined) return {};
  const innermost = fault.causes[fault.causes.length - 1];
  return {
    code: fault.code,
    origin: fault.origin,
    kind: fault.kind,
    retryable: fault.retryable,
    ...(fault.service === undefined ? {} : { service: fault.service }),
    ...(fault.where === undefined ? {} : { where: fault.where }),
    ...(innermost === undefined ? {} : { cause: formatCause(innermost) }),
    ...(fault.hints.length === 0 ? {} : { hints: fault.hints.slice(0, MAX_HINTS) }),
  };
};

/** One compact failure row: the trace facts plus its classification. */
const errorRow = (trace: RequestTrace): AiRecentError => ({
  id: trace.id,
  ts: trace.ts,
  method: trace.method,
  path: trace.path,
  status: trace.status,
  error: trace.error as string,
  ...faultFacts(trace.fault),
  ...(trace.faultFrames?.appWhere === undefined ? {} : { appWhere: trace.faultFrames.appWhere }),
});

/** Fault-code histogram over the retained ring (`IGN_DB_CREDENTIALS → 12`). */
const errorCodeCounts = (traces: readonly RequestTrace[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const trace of traces) {
    const code = trace.fault?.code;
    if (code !== undefined) counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
};

/** Read + shape the nova trace ring (undefined when the probe is absent). */
const novaSection = (handle: ReturnType<typeof novaHandle>): AiDebugSummary["nova"] => {
  if (handle === null || typeof handle.getEventTrace !== "function") return undefined;
  try {
    const doc = handle.getEventTrace({ limit: 8 }) as NovaEventTrace;
    if (doc === undefined || doc === null) return undefined;
    const st = doc.stats;
    return {
      enabled: doc.enabled,
      size: st.size,
      total: st.total,
      inCount: st.inCount,
      outCount: st.outCount,
      byName: st.byName,
      recent: doc.recent.map((r) => ({
        ts: r.ts,
        direction: r.direction,
        name: r.name,
        ...(r.target !== undefined ? { target: r.target } : {}),
        ...(r.key !== undefined ? { key: r.key } : {}),
        bytes: r.bytes,
      })),
    };
  } catch {
    // A broken probe must not break the summary.
    return undefined;
  }
};

/** Build the `GET /api/ai/summary` handler for one debugbar instance. */
export const createAiSummaryHandler =
  (deps: HandlerDeps, ktData: KnowledgeProbe) => async (): Promise<Response> => {
    const p = deps.state.store.percentiles();
    const traces = deps.state.store.list();
    const recentErrors = traces
      .filter((t) => t.error !== null)
      .slice(0, 8)
      .map(errorRow);
    const errorCodes = errorCodeCounts(traces);
    const slowest = [...traces]
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, 5)
      .map((t) => ({
        id: t.id,
        ts: t.ts,
        method: t.method,
        path: t.path,
        durationMs: t.durationMs,
        status: t.status,
      }));
    const eventStats = deps.state.nats?.stats() ?? null;
    const nova = novaSection(novaHandle(deps));
    const clients = deps.state.clients.list(clientProbePaths(deps)).map((c) => ({
      kind: c.kind,
      platform: c.platform,
      name: c.name,
      version: c.version,
      published: c.published,
      gitTags: c.gitTags.slice(0, 5),
    }));
    const { knowledge } = await ktData();
    const diagnostics = analyzeSamples(deps.state.profiler.stats().samples);
    const badLogs = deps.state.logs.list({ minLevel: "warn", limit: 5 });
    const sinkStatus = deps.state.sink?.status();
    const summary: AiDebugSummary = {
      service: deps.state.serviceName,
      version: deps.state.version,
      environment: process.env.NODE_ENV ?? "development",
      uptimeSec: Math.round(process.uptime()),
      traces: {
        total: deps.state.store.size,
        errors: deps.state.store.errorCount,
        avgDurationMs: p.avgMs,
        p95DurationMs: p.p95Ms,
        recentErrors,
        ...(Object.keys(errorCodes).length === 0 ? {} : { errorCodes }),
        slowest,
      },
      events: {
        enabled: eventStats?.enabled ?? false,
        connected: eventStats?.connected ?? false,
        total: eventStats?.total ?? 0,
        errors: eventStats?.errors ?? 0,
        bySubject: eventStats?.bySubject ?? {},
      },
      clients,
      ...(nova !== undefined ? { nova } : {}),
      observatory: {
        verdict: diagnostics.verdict,
        findings: diagnostics.findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          title: f.title,
        })),
        heapMiBPerMin: diagnostics.trend.heapMiBPerMin,
        logErrors: deps.state.logs.stats().error,
        recentWarnings: badLogs.map((l) => ({
          ts: l.ts,
          level: l.level as string,
          message: l.message.slice(0, 200),
          ...(l.traceId !== null ? { traceId: l.traceId } : {}),
        })),
        persist: {
          enabled: sinkStatus?.available ?? false,
          path: sinkStatus?.path ?? null,
        },
      },
      routes: knowledge.routes.length,
    };
    return json(summary);
  };
