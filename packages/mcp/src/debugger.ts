/**
 * @fileoverview Debugbar client for the MCP server — lets an AI agent connect
 * to a running ignex app's debugbar (`/__debugbar/api/*`) and debug issues
 * directly: read the compact AI summary, list/read/replay requests, inspect
 * NATS event queues and publish probe events, check the system profile and
 * pull the KT knowledge page.
 *
 * Token efficiency is the design goal:
 * - `/api/ai/summary` is one small JSON document — the agent fetches it first,
 *   sees errors/slow traces/event stats at a glance, and only then drills into
 *   specific requests via `/api/requests/:id` (full span detail) when needed.
 * - All list endpoints accept `limit`/`q`/`error` filters server-side, so the
 *   agent never downloads the whole ring buffer.
 *
 * The base URL + token come from `IGNEX_DEBUGBAR_URL` / `IGNEX_DEBUGBAR_TOKEN`
 * (or per-call `url`/`token` args). Everything degrades to a descriptive
 * string error — never a protocol-level exception.
 */

/** Resolved debugbar endpoint config. */
export interface DebugbarTarget {
  readonly baseUrl: string;
  readonly token: string | null;
}

/** Normalize a target: env defaults, strip trailing slash, validate http(s). */
export const resolveDebugbarTarget = (
  url: string | undefined,
  token: string | undefined,
): DebugbarTarget => {
  const raw = url ?? process.env.IGNEX_DEBUGBAR_URL ?? "";
  const baseUrl = raw.trim().replace(/\/+$/, "");
  if (baseUrl === "") {
    throw new Error(
      "No debugbar URL. Set IGNEX_DEBUGBAR_URL (or pass url) — e.g. http://localhost:3000/__debugbar",
    );
  }
  if (!/^https?:\/\//.test(baseUrl)) {
    throw new Error(
      `Invalid debugbar URL "${baseUrl}" — expected http(s)://host[:port]/__debugbar`,
    );
  }
  return { baseUrl, token: token ?? process.env.IGNEX_DEBUGBAR_TOKEN ?? null };
};

/** One fetch against the debugbar API (token appended, no-store). */
export const debugbarFetch = async (
  target: DebugbarTarget,
  path: string,
  init: RequestInit = {},
): Promise<unknown> => {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${target.baseUrl}/api${path}${target.token ? `${sep}token=${encodeURIComponent(target.token)}` : ""}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(init.headers as Record<string, string>),
  };
  const response = await fetch(url, { ...init, headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `debugbar HTTP ${response.status} for ${path}${text ? `: ${text.slice(0, 300)}` : ""}`,
    );
  }
  return (await response.json()) as unknown;
};

/** Compact JSON stringify (stable key order, bounded depth for token savings). */
const compactJson = (value: unknown): string => JSON.stringify(value);

/* ── tool runners (each returns a plain string for the MCP text block) ── */

/** Fetch the compact AI summary: errors, slow traces, events, clients. */
export const runDebugSummaryTool = async (args: {
  url?: string;
  token?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const summary = await debugbarFetch(target, "/ai/summary");
    return compactJson(summary);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** List recent request traces (server-side filtered + limited). */
export const runDebugRequestsTool = async (args: {
  url?: string;
  token?: string;
  limit?: number;
  error?: boolean;
  q?: string;
  method?: string;
  status?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(args.limit ?? 50, 1), 200)));
    if (args.error === true) params.set("error", "1");
    if (args.q) params.set("q", args.q);
    if (args.method) params.set("method", args.method);
    if (args.status) params.set("status", args.status);
    const rows = (await debugbarFetch(target, `/requests?${params.toString()}`)) as unknown;
    return compactJson(rows);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** Full detail of one request (spans, waterfall, headers, error stack). */
export const runDebugRequestTool = async (args: {
  url?: string;
  token?: string;
  id: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const detail = await debugbarFetch(target, `/requests/${encodeURIComponent(args.id)}`);
    return compactJson(detail);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** Replay a stored request through the live server. */
export const runDebugReplayTool = async (args: {
  url?: string;
  token?: string;
  id: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const result = await debugbarFetch(target, `/requests/${encodeURIComponent(args.id)}/replay`, {
      method: "POST",
    });
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** List recent NATS events (with optional subject filter). */
export const runDebugEventsTool = async (args: {
  url?: string;
  token?: string;
  limit?: number;
  subject?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(args.limit ?? 50, 1), 200)));
    if (args.subject) params.set("subject", args.subject);
    const result = await debugbarFetch(target, `/events?${params.toString()}`);
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** Publish a probe event through the app's NATS connection. */
export const runDebugEventPublishTool = async (args: {
  url?: string;
  token?: string;
  subject: string;
  payload?: unknown;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    if (!args.subject || args.subject.trim() === "") {
      return compactJson({ ok: false, error: "subject is required" });
    }
    const result = await debugbarFetch(target, "/events/publish", {
      method: "POST",
      body: JSON.stringify({ subject: args.subject.trim(), payload: args.payload ?? {} }),
    });
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/**
 * What fired in the app's nova FlatBuffer transport (emits, publishes,
 * client/remote/bridge inbound) — the running realtime event log with
 * per-event aggregates. Requires the app to wire `data.nova` into its
 * debugbar; otherwise the response carries an `enabled: false` hint.
 */
export const runDebugNovaEventsTool = async (args: {
  url?: string;
  token?: string;
  limit?: number;
  name?: string;
  direction?: string;
  clear?: boolean;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    if (args.clear === true) {
      const cleared = await debugbarFetch(target, "/nova/events/clear", { method: "POST" });
      return compactJson(cleared);
    }
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(args.limit ?? 50, 1), 500)));
    if (args.name) params.set("name", args.name);
    if (args.direction) params.set("direction", args.direction);
    const result = await debugbarFetch(target, `/nova/events?${params.toString()}`);
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** System profile: CPU/RSS/heap/event-loop charts + request totals. */
export const runDebugSystemTool = async (args: {
  url?: string;
  token?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const stats = await debugbarFetch(target, "/system");
    return compactJson(stats);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** Published clients (SDK + flatbuffers client) with git tags + local state. */
export const runDebugClientsTool = async (args: {
  url?: string;
  token?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const clients = await debugbarFetch(target, "/clients");
    return compactJson(clients);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** KT knowledge page (markdown) — how this app works, for fast onboarding. */
export const runDebugKtTool = async (args: { url?: string; token?: string }): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const kt = (await debugbarFetch(target, "/kt")) as { markdown?: unknown };
    return typeof kt.markdown === "string" ? kt.markdown : compactJson(kt);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/* ── observatory tools ─────────────────────────────────────────────────── */

/**
 * Structured log records from the observatory — live ring by default or the
 * SQLite-persisted history (`persisted: true`), filterable by minimum level,
 * text search and correlated trace id.
 */
export const runDebugLogsTool = async (args: {
  url?: string;
  token?: string;
  limit?: number;
  level?: "debug" | "info" | "warn" | "error";
  q?: string;
  traceId?: string;
  persisted?: boolean;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(args.limit ?? 100, 1), 500)));
    if (args.level) params.set("level", args.level);
    if (args.q) params.set("q", args.q);
    if (args.traceId) params.set("traceId", args.traceId);
    if (args.persisted === true) params.set("persisted", "1");
    const result = await debugbarFetch(target, `/logs?${params.toString()}`);
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/**
 * Aggregated metrics: per-route request counts/errors/duration quantiles,
 * system gauges and app counters. Set `format: "prometheus"` for the raw
 * Prometheus exposition text (what a Grafana scrape would pull).
 */
export const runDebugMetricsTool = async (args: {
  url?: string;
  token?: string;
  format?: "json" | "prometheus";
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    if (args.format === "prometheus") {
      const sep = target.token
        ? `${"/metrics/prometheus".includes("?") ? "&" : "?"}token=${encodeURIComponent(target.token)}`
        : "";
      const response = await fetch(`${target.baseUrl}/api/metrics/prometheus${sep}`, {
        headers: { accept: "text/plain" },
      });
      if (!response.ok) throw new Error(`debugbar HTTP ${response.status} for /metrics/prometheus`);
      return (await response.text()).slice(0, 20_000);
    }
    const result = await debugbarFetch(target, "/metrics");
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/**
 * Leak/trend diagnostics: verdict + findings with measured evidence
 * (heap/RSS slopes with R² gating, event-loop saturation, request-drain).
 * With `gc: true`, forces a full GC first and reports freed memory.
 */
export const runDebugDiagnosticsTool = async (args: {
  url?: string;
  token?: string;
  gc?: boolean;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    if (args.gc === true) {
      const gcResult = await debugbarFetch(target, "/diagnostics/gc", { method: "POST" });
      return compactJson({ gc: gcResult });
    }
    const result = await debugbarFetch(target, "/diagnostics");
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/** Application/process state snapshot: runtime, memory, env names, features. */
export const runDebugStateTool = async (args: {
  url?: string;
  token?: string;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    const result = await debugbarFetch(target, "/state");
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};

/**
 * Persisted history (cross-restart): query the SQLite observatory db for
 * traces older than the in-memory ring. With an `id`, returns one fully
 * reconstructed trace (spans included).
 */
export const runDebugHistoryTool = async (args: {
  url?: string;
  token?: string;
  id?: string;
  limit?: number;
  q?: string;
  method?: string;
  status?: string;
  error?: boolean;
  minMs?: number;
  since?: number;
  until?: number;
}): Promise<string> => {
  try {
    const target = resolveDebugbarTarget(args.url, args.token);
    if (args.id) {
      const detail = await debugbarFetch(target, `/history/${encodeURIComponent(args.id)}`);
      return compactJson(detail);
    }
    const params = new URLSearchParams();
    params.set("limit", String(Math.min(Math.max(args.limit ?? 50, 1), 200)));
    if (args.q) params.set("q", args.q);
    if (args.method) params.set("method", args.method);
    if (args.status) params.set("status", args.status);
    if (args.error === true) params.set("error", "1");
    if (args.minMs !== undefined) params.set("minMs", String(args.minMs));
    if (args.since !== undefined) params.set("since", String(args.since));
    if (args.until !== undefined) params.set("until", String(args.until));
    const result = await debugbarFetch(target, `/history?${params.toString()}`);
    return compactJson(result);
  } catch (error) {
    return compactJson({ ok: false, error: String(error) });
  }
};
