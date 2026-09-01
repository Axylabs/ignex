/**
 * @fileoverview Typed API client for the debugbar's JSON endpoints.
 *
 * One place knows the mount path (`BASE`, read from the serving script tag's
 * `data-base` attribute), the token header and the SSE ticket flow. Wire
 * shapes are imported (type-only) from the server's own `types.ts`, so client
 * and server cannot drift silently — a renamed field is a compile error.
 */

import type { PublishedClient } from "../clients";
import type { TraceSummary } from "../store";
import type {
  AiDebugSummary,
  AppKnowledge,
  DiagnosticsReport,
  HistoryTraceSummary,
  LogLevel,
  LogRecord,
  LogStats,
  MetricsSnapshot,
  PersistStatus,
  RequestTrace,
  SystemStats,
} from "../types";

/** Route inventory row (`GET /api/routes`). */
interface RouteRow {
  method: string;
  path: string;
  file?: string;
}

/** Durable-jobs panel payload (`GET /api/jobs`). */
export interface JobsPanel {
  enabled: boolean;
  error?: string;
  total?: number;
  byStatus?: Record<string, number>;
  recent?: Array<{ name: string; status: string; runAt: number }>;
}

/** History list payload — same row shape as live summaries. */
export interface HistoryList {
  enabled: boolean;
  rows: HistoryTraceSummary[];
}

/** Dashboard mount path, injected via `<script data-base="…">`. */
export const BASE: string =
  document.currentScript?.getAttribute("data-base") ??
  document.querySelector("script[data-base]")?.getAttribute("data-base") ??
  ".";

/** Page-load query token (from the one-time `?token=` handshake URL). */
const TOKEN: string = new URLSearchParams(window.location.search).get("token") ?? "";

/** JSON GET with the auth header; throws on non-2xx. */
const getJson = async <T>(path: string): Promise<T> => {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { accept: "application/json", "x-debugbar-token": TOKEN },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return (await res.json()) as T;
};

/** POST (JSON body optional); parses whatever JSON comes back. */
const postJson = async <T>(path: string, body?: unknown): Promise<T> => {
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: {
      "x-debugbar-token": TOKEN,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`HTTP ${res.status} ${path}`);
  }
};

/** Boot/feature metadata (`GET /api/meta`). */
export interface MetaInfo {
  serviceName: string;
  version: string;
  environment: string;
  debugMode: boolean;
  path: string;
  nativeAvailable: boolean;
  bufferSize?: number;
  features?: { logs?: boolean; metrics?: boolean; diagnostics?: boolean; history?: boolean };
}

interface ListFilters {
  q?: string | undefined;
  method?: string | undefined;
  status?: string | undefined;
  minMs?: string | undefined;
  errorsOnly?: boolean | undefined;
  limit?: number | undefined;
}

/** Serialize filters into a query string (empty values dropped). */
const filtersToQuery = (filters: ListFilters): string => {
  const params = new URLSearchParams();
  const put = (key: string, value: string | number | boolean | undefined): void => {
    if (value === undefined || value === "" || value === false) return;
    params.set(key, value === true ? "1" : String(value));
  };
  put("q", filters.q);
  put("method", filters.method);
  put("status", filters.status);
  put("minMs", filters.minMs);
  put("error", filters.errorsOnly);
  params.set("limit", String(filters.limit ?? 200));
  return `?${params.toString()}`;
};

/** `GET /api/meta` — boot info. */
export const getMeta = (): Promise<MetaInfo> => getJson<MetaInfo>("/meta");

/** `GET /api/requests` — live trace summaries. */
export const getRequests = (filters: ListFilters): Promise<TraceSummary[]> =>
  getJson<TraceSummary[]>(`/requests${filtersToQuery(filters)}`);

/** `GET /api/requests/:id` — full live trace (+ curl + sourceFile). */
export const getRequestDetail = (id: string): Promise<RequestTrace> =>
  getJson<RequestTrace>(`/requests/${encodeURIComponent(id)}`);

/** `POST /api/requests/:id/replay` — re-issue a stored request. */
export const replayRequest = (
  id: string,
): Promise<{
  status?: number;
  durationMs?: number;
  requestId?: string;
  body?: string;
  error?: string;
}> => postJson(`/requests/${encodeURIComponent(id)}/replay`);

/** `GET /api/requests/clear` — drop the live ring. */
export const clearRequests = (): Promise<{ ok: boolean }> => postJson("/requests/clear");

/** `GET /api/system` — profiler stats + samples. */
export const getSystem = (): Promise<SystemStats> => getJson<SystemStats>("/system");

/** `GET /api/state` — app/process snapshot. */
export const getState = (): Promise<Record<string, unknown>> => getJson("/state");

/** `GET /api/kt` — knowledge transfer payload. */
export const getKt = (): Promise<{
  markdown: string;
  html: string | null;
  knowledge: AppKnowledge;
}> => getJson("/kt");

/** `GET /api/clients` — published clients registry. */
export const getClients = (
  refresh = false,
): Promise<{
  enabled: boolean;
  count: number;
  gitError?: string | null;
  clients: PublishedClient[];
}> => getJson(`/clients${refresh ? "?refresh=1" : ""}`);

/** `GET /api/logs` — structured log records. */
export const getLogs = (options: {
  q?: string | undefined;
  level?: string | undefined;
  persisted?: boolean | undefined;
  limit?: number | undefined;
}): Promise<{
  enabled: boolean;
  persisted: boolean;
  available?: boolean;
  records: LogRecord[];
  stats: LogStats | null;
}> => {
  const params = new URLSearchParams();
  params.set("limit", String(options.limit ?? 300));
  if (options.q) params.set("q", options.q);
  if (options.level) params.set("level", options.level as LogLevel);
  if (options.persisted) params.set("persisted", "1");
  return getJson(`/logs?${params.toString()}`);
};

/** `GET /api/logs/:id` — one full log record. */
export const getLogDetail = (id: number): Promise<LogRecord> =>
  getJson<LogRecord>(`/logs/${encodeURIComponent(id)}`);

/** `POST /api/logs/clear` — drop the log ring. */
export const clearLogs = (): Promise<{ ok: boolean }> => postJson("/logs/clear");

/** `GET /api/metrics` — JSON metrics snapshot. */
export const getMetrics = (): Promise<MetricsSnapshot> => getJson<MetricsSnapshot>("/metrics");

/** `GET /api/diagnostics` — leak/trend report. */
export const getDiagnostics = (): Promise<DiagnosticsReport & { persist?: PersistStatus }> =>
  getJson<DiagnosticsReport & { persist?: PersistStatus }>("/diagnostics");

/** `POST /api/diagnostics/gc` — force GC; returns freed memory stats. */
export const runGc = (): Promise<{
  ok: boolean;
  supported: boolean;
  freedMiB: number;
  beforeHeapUsedMiB: number;
  afterHeapUsedMiB: number;
}> => postJson("/diagnostics/gc");

/** `GET /api/history` — persisted traces (cross-restart). */
export const getHistory = (
  filters: ListFilters,
): Promise<{ enabled: boolean; rows: HistoryTraceSummary[] }> =>
  getJson(`/history${filtersToQuery(filters)}`);

/** `GET /api/history/:id` — one reconstructed persisted trace. */
export const getHistoryDetail = (id: string): Promise<RequestTrace> =>
  getJson<RequestTrace>(`/history/${encodeURIComponent(id)}`);

/** `GET /api/jobs` — durable job store panel. */
export const getJobs = (): Promise<JobsPanel> => getJson<JobsPanel>("/jobs");

/** `GET /api/routes` — route inventory. */
export const getRoutes = (): Promise<{ enabled: boolean; routes: RouteRow[] }> =>
  getJson("/routes");

/** `GET /api/events` — NATS tracker panel. */
export const getEvents = (
  q?: string,
): Promise<{
  enabled: boolean;
  hint?: string;
  stats: Record<string, unknown> | null;
  recent: Array<{
    ts: number;
    direction: "in" | "out";
    subject: string;
    size: number;
    payload?: string;
    error?: string | null;
  }>;
}> => getJson(`/events?limit=250${q ? `&subject=${encodeURIComponent(q)}` : ""}`);

/** `POST /api/events/publish` — publish a probe event. */
export const publishEvent = (
  subject: string,
  payload: unknown,
): Promise<{ ok: boolean; error?: string }> => postJson("/events/publish", { subject, payload });

/** `POST /api/events/clear` — drop the event buffer. */
export const clearEvents = (): Promise<{ ok: boolean }> => postJson("/events/clear");

/** `GET /api/ai/summary` — compact AI-facing snapshot. */
export const getAiSummary = (): Promise<AiDebugSummary> => getJson<AiDebugSummary>("/ai/summary");

/**
 * `POST /api/stream/ticket` — mint a short-TTL ticket authorizing ONE
 * `/api/stream` connection. EventSource cannot send custom headers, so the
 * live stream authenticates via this single-use ticket instead of a
 * query-string token (which never touches access logs).
 */
const requestStreamTicket = (): Promise<{ ticket: string }> =>
  postJson<{ ticket: string }>("/stream/ticket");

/** Revision counters pushed by the live stream (per data domain). */
export interface StreamRevision {
  epoch: number;
  traces: number;
  logs: number;
  metrics: number;
  system: number;
  events: number;
}

interface StreamHandlers {
  onRevision: (rev: StreamRevision) => void;
  /** Transport-level failure after retries were exhausted (fallback to polling). */
  onDown: () => void;
}

const STREAM_RETRY_MS = [0, 1000, 5000] as const;

/**
 * Open the live revision stream with ticket auth, manual reconnects (new
 * ticket each time) and bounded backoff. Returns a closer.
 */
export const openStream = (handlers: StreamHandlers): (() => void) => {
  let source: EventSource | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const close = (): void => {
    closed = true;
    source?.close();
    source = null;
    if (retryTimer !== null) clearTimeout(retryTimer);
  };

  const connect = async (): Promise<void> => {
    while (!closed) {
      try {
        const { ticket } = await requestStreamTicket();
        if (closed) return;
        await new Promise<void>((resolve) => {
          source = new EventSource(`${BASE}/api/stream?ticket=${encodeURIComponent(ticket)}`);
          const es = source;
          es.addEventListener("revision", (ev) => {
            attempt = 0;
            try {
              handlers.onRevision(JSON.parse((ev as MessageEvent<string>).data) as StreamRevision);
            } catch {
              /* malformed frame — ignore */
            }
          });
          es.onerror = (): void => {
            es.close();
            resolve();
          };
          es.onopen = (): void => {};
        });
      } catch {
        /* ticket minting failed — fall through to backoff */
      }
      if (closed) return;
      if (attempt >= STREAM_RETRY_MS.length) {
        handlers.onDown();
        return;
      }
      const wait = STREAM_RETRY_MS[attempt] ?? 5000;
      attempt++;
      await new Promise<void>((resolve) => {
        retryTimer = setTimeout(resolve, wait);
      });
    }
  };
  void connect();
  return close;
};
