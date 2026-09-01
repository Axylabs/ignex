/**
 * Debugger (MCP) tests — the AI-facing debugbar client. A tiny local HTTP
 * server serves debugbar-shaped fixtures so the tools are tested end-to-end
 * (URL resolution, token appending, error handling, payload shapes).
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveDebugbarTarget,
  runDebugClientsTool,
  runDebugDiagnosticsTool,
  runDebugEventPublishTool,
  runDebugEventsTool,
  runDebugHistoryTool,
  runDebugKtTool,
  runDebugLogsTool,
  runDebugMetricsTool,
  runDebugNovaEventsTool,
  runDebugReplayTool,
  runDebugRequestsTool,
  runDebugRequestTool,
  runDebugStateTool,
  runDebugSummaryTool,
  runDebugSystemTool,
} from "../src/debugger.js";

let baseUrl: string;
let server: Server | undefined;

/** Request log so tests can assert what the client sent. */
const requests: Array<{ method: string; path: string; body: string }> = [];

const json = (data: unknown): string => JSON.stringify(data);

/** Fixture responses served by URL suffix (more specific paths first). */
const fixtures: Array<{ suffix: string; body: unknown }> = [
  {
    suffix: "/api/ai/summary",
    body: {
      service: "demo",
      traces: { total: 3, errors: 1, recentErrors: [], slowest: [] },
      events: { enabled: true },
      clients: [],
    },
  },
  { suffix: "/api/requests/r-1/replay", body: { ok: true, status: 200, durationMs: 5 } },
  {
    suffix: "/api/requests/r-1",
    body: { id: "r-1", spans: [], error: "boom", request: { url: "http://x/" } },
  },
  {
    suffix: "/api/requests",
    body: [{ id: "r-1", method: "GET", path: "/health", status: 500, error: "boom" }],
  },
  { suffix: "/api/events/publish", body: { ok: true, subject: "a.b" } },
  {
    suffix: "/api/nova/events/clear",
    body: { ok: true, cleared: true },
  },
  {
    suffix: "/api/nova/events",
    body: {
      enabled: true,
      capacity: 1024,
      stats: { size: 1, total: 1, inCount: 0, outCount: 1, bytes: 32, byName: { "quote.tick": 1 } },
      recent: [
        {
          seq: 1,
          ts: 1720000000000,
          direction: "out.emit",
          name: "quote.tick",
          target: "user",
          key: "u-42",
          bytes: 32,
        },
      ],
    },
  },
  {
    suffix: "/api/events",
    body: {
      enabled: true,
      stats: { total: 2 },
      recent: [{ subject: "a.b", direction: "out", payload: "{}" }],
    },
  },
  { suffix: "/api/system", body: { sampling: true, samples: [] } },
  {
    suffix: "/api/diagnostics/gc",
    body: { ok: true, freedMiB: 3.2, beforeHeapUsedMiB: 40, afterHeapUsedMiB: 36.8 },
  },
  {
    suffix: "/api/diagnostics",
    body: {
      verdict: "warning",
      checkedAt: 1,
      windowMin: 10,
      samplesAnalyzed: 600,
      findings: [
        {
          id: "heap-growth",
          severity: "warning",
          title: "Heap climbing 0.8 MiB/min",
          detail: "d",
          evidence: { slopeMiBPerMin: 0.8 },
          recommendation: "r",
        },
      ],
      trend: {
        heapMiBPerMin: 0.8,
        heapR2: 0.9,
        heapNowMiB: 120,
        heapMinMiB: 60,
        heapMaxMiB: 122,
        rssMiBPerMin: 0.2,
        eventLoopP95Ms: 12,
        activeRequestsMax: 4,
      },
    },
  },
  {
    suffix: "/api/state",
    body: {
      service: "demo",
      runtime: { bunVersion: "1.4", uptimeSec: 30 },
      memory: { rssMiB: 80 },
      envKeys: ["PATH"],
      features: { logs: true, metrics: true, persist: true },
    },
  },
  { suffix: "/api/history/h-1", body: { id: "h-1", spans: [{ name: "SELECT" }] } },
  {
    suffix: "/api/history",
    body: {
      enabled: true,
      rows: [{ id: "h-1", method: "GET", path: "/old", status: 200, durationMs: 4 }],
    },
  },
  {
    suffix: "/api/logs",
    body: {
      enabled: true,
      persisted: false,
      records: [{ ts: 1, level: "warn", message: "cache miss", traceId: "t-9" }],
      stats: { total: 1, warn: 1, error: 0, info: 0, debug: 0 },
    },
  },
  {
    suffix: "/api/metrics",
    body: {
      startedAt: 0,
      uptimeSec: 5,
      totals: { requests: 7, errors: 1 },
      gauges: {},
      counters: [],
      routes: [{ key: "GET /x", requests: 7 }],
      durationBucketsMs: [10],
    },
  },
  {
    suffix: "/api/clients",
    body: {
      count: 1,
      clients: [{ name: "@acme/api-client", version: "1.0.0", published: "local", gitTags: [] }],
    },
  },
  { suffix: "/api/kt", body: { markdown: "# demo — how this app works" } },
];

/** Match a pathname against the fixture table and write the response. */
const respond = (pathname: string, res: ServerResponse): void => {
  if (pathname.endsWith("/api/metrics/prometheus")) {
    res.setHeader("content-type", "text/plain; version=0.0.4");
    res.end(
      '# TYPE ignex_http_requests_total counter\nignex_http_requests_total{route="GET /x"} 7\n',
    );
    return;
  }
  res.setHeader("content-type", "application/json");
  for (const fixture of fixtures) {
    if (pathname.endsWith(fixture.suffix)) {
      res.end(json(fixture.body));
      return;
    }
  }
  res.statusCode = 404;
  res.end(json({ error: "not_found" }));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += String(d);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body });
      respond(url.pathname, res);
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/__debugbar`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("resolveDebugbarTarget", () => {
  it("reads env defaults and normalizes the base URL", () => {
    const target = resolveDebugbarTarget("http://localhost:3000/__debugbar/", undefined);
    expect(target.baseUrl).toBe("http://localhost:3000/__debugbar");
    expect(target.token).toBeNull();
  });

  it("throws a descriptive error without a URL", () => {
    expect(() => resolveDebugbarTarget(undefined, undefined)).toThrow(/IGNEX_DEBUGBAR_URL/);
  });

  it("rejects non-http URLs", () => {
    expect(() => resolveDebugbarTarget("file:///tmp", undefined)).toThrow(/http/);
  });
});

describe("debugger tools", () => {
  it("summary tool returns the compact snapshot", async () => {
    const out = await runDebugSummaryTool({ url: baseUrl });
    const parsed = JSON.parse(out) as { service: string; traces: { errors: number } };
    expect(parsed.service).toBe("demo");
    expect(parsed.traces.errors).toBe(1);
  });

  it("requests tool applies filters via query params", async () => {
    await runDebugRequestsTool({ url: baseUrl, error: true, limit: 5, q: "health" });
    const call = requests.find((r) => r.path.startsWith("/__debugbar/api/requests"));
    expect(call?.path).toContain("error=1");
    expect(call?.path).toContain("limit=5");
    expect(call?.path).toContain("q=health");
  });

  it("request/replay/events/publish/system/clients/kt tools", async () => {
    const detail = JSON.parse(await runDebugRequestTool({ url: baseUrl, id: "r-1" })) as {
      id: string;
    };
    expect(detail.id).toBe("r-1");

    const replay = JSON.parse(await runDebugReplayTool({ url: baseUrl, id: "r-1" })) as {
      ok: boolean;
    };
    expect(replay.ok).toBe(true);

    const events = JSON.parse(await runDebugEventsTool({ url: baseUrl })) as {
      enabled: boolean;
      recent: Array<{ subject: string }>;
    };
    expect(events.enabled).toBe(true);
    expect(events.recent[0]?.subject).toBe("a.b");

    const pub = JSON.parse(
      await runDebugEventPublishTool({ url: baseUrl, subject: "a.b", payload: { x: 1 } }),
    ) as {
      ok: boolean;
    };
    expect(pub.ok).toBe(true);

    const sys = JSON.parse(await runDebugSystemTool({ url: baseUrl })) as { sampling: boolean };
    expect(sys.sampling).toBe(true);

    const clients = JSON.parse(await runDebugClientsTool({ url: baseUrl })) as {
      count: number;
    };
    expect(clients.count).toBe(1);

    const kt = await runDebugKtTool({ url: baseUrl });
    expect(kt).toContain("how this app works");
  });

  it("nova event trace: lists rows, applies filters, and clears", async () => {
    const listed = JSON.parse(
      await runDebugNovaEventsTool({ url: baseUrl, limit: 10, direction: "out.emit" }),
    ) as {
      enabled: boolean;
      stats: { byName: Record<string, number> };
      recent: Array<{ name: string; key?: string }>;
    };
    expect(listed.enabled).toBe(true);
    expect(listed.stats.byName).toMatchObject({ "quote.tick": 1 });
    expect(listed.recent[0]?.name).toBe("quote.tick");
    expect(listed.recent[0]?.key).toBe("u-42");
    // the query reached the debugbar (limit + direction params)
    const call = requests.findLast((r) => r.path.includes("/api/nova/events?"));
    expect(call?.path).toContain("limit=10");
    expect(call?.path).toContain("direction=out.emit");

    const cleared = JSON.parse(await runDebugNovaEventsTool({ url: baseUrl, clear: true })) as {
      ok: boolean;
      cleared: boolean;
    };
    expect(cleared).toMatchObject({ ok: true, cleared: true });
  });

  it("degrades to a structured error on failure", async () => {
    const out = await runDebugSummaryTool({ url: "http://127.0.0.1:1/__debugbar" });
    const parsed = JSON.parse(out) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it("requires a subject for publish", async () => {
    const out = JSON.parse(await runDebugEventPublishTool({ url: baseUrl, subject: " " })) as {
      ok: boolean;
    };
    expect(out.ok).toBe(false);
  });
});

describe("observatory tools", () => {
  it("logs tool passes level/search/trace/persisted filters", async () => {
    const parsed = JSON.parse(
      await runDebugLogsTool({
        url: baseUrl,
        level: "warn",
        q: "cache",
        traceId: "t-9",
        persisted: true,
        limit: 25,
      }),
    ) as { enabled: boolean; records: Array<{ message: string }> };
    expect(parsed.enabled).toBe(true);
    expect(parsed.records[0]?.message).toBe("cache miss");
    const call = requests.findLast((r) => r.path.includes("/api/logs?"));
    expect(call?.path).toContain("level=warn");
    expect(call?.path).toContain("persisted=1");
    expect(call?.path).toContain("traceId=t-9");
    expect(call?.path).toContain("limit=25");
  });

  it("metrics tool returns JSON by default and raw Prometheus text on demand", async () => {
    const snap = JSON.parse(await runDebugMetricsTool({ url: baseUrl })) as {
      totals: { requests: number };
      routes: Array<{ key: string }>;
    };
    expect(snap.totals.requests).toBe(7);
    expect(snap.routes[0]?.key).toBe("GET /x");

    const text = await runDebugMetricsTool({ url: baseUrl, format: "prometheus" });
    expect(text).toContain("# TYPE ignex_http_requests_total counter");
    expect(text).toContain('ignex_http_requests_total{route="GET /x"} 7');
    const call = requests.findLast((r) => r.path.includes("/api/metrics/prometheus"));
    expect(call?.method).toBe("GET");
  });

  it("diagnostics tool returns findings and supports forced GC", async () => {
    const diag = JSON.parse(await runDebugDiagnosticsTool({ url: baseUrl })) as {
      verdict: string;
      trend: { heapMiBPerMin: number };
      findings: Array<{ id: string }>;
    };
    expect(diag.verdict).toBe("warning");
    expect(diag.trend.heapMiBPerMin).toBeCloseTo(0.8);
    expect(diag.findings[0]?.id).toBe("heap-growth");

    const gc = JSON.parse(await runDebugDiagnosticsTool({ url: baseUrl, gc: true })) as {
      gc: { freedMiB: number };
    };
    expect(gc.gc.freedMiB).toBeCloseTo(3.2);
    const call = requests.findLast((r) => r.path.includes("/api/diagnostics/gc"));
    expect(call?.method).toBe("POST");
  });

  it("state tool returns the app snapshot", async () => {
    const state = JSON.parse(await runDebugStateTool({ url: baseUrl })) as {
      service: string;
      features: { persist: boolean };
      envKeys: string[];
    };
    expect(state.service).toBe("demo");
    expect(state.features.persist).toBe(true);
    expect(state.envKeys).toContain("PATH");
  });

  it("history tool lists rows and fetches single traces", async () => {
    const rows = JSON.parse(await runDebugHistoryTool({ url: baseUrl, error: true })) as {
      enabled: boolean;
      rows: Array<{ id: string }>;
    };
    expect(rows.rows[0]?.id).toBe("h-1");
    const call = requests.findLast((r) => r.path.startsWith("/__debugbar/api/history?"));
    expect(call?.path).toContain("error=1");

    const detail = JSON.parse(await runDebugHistoryTool({ url: baseUrl, id: "h-1" })) as {
      spans: Array<{ name: string }>;
    };
    expect(detail.spans[0]?.name).toBe("SELECT");
  });

  it("observatory tools degrade to structured errors on unreachable targets", async () => {
    for (const run of [
      () => runDebugLogsTool({ url: "http://127.0.0.1:1/__debugbar" }),
      () => runDebugMetricsTool({ url: "http://127.0.0.1:1/__debugbar" }),
      () => runDebugDiagnosticsTool({ url: "http://127.0.0.1:1/__debugbar" }),
      () => runDebugStateTool({ url: "http://127.0.0.1:1/__debugbar" }),
      () => runDebugHistoryTool({ url: "http://127.0.0.1:1/__debugbar" }),
    ]) {
      const out = JSON.parse(await run()) as { ok: boolean; error: string };
      expect(out.ok).toBe(false);
      expect(out.error).toBeTruthy();
    }
  });
});
