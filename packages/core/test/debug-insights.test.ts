/**
 * @fileoverview Application-overview analyzer tests: severity thresholds,
 * evidence, N+1/query detection, runtime findings and coverage summaries.
 */

import { describe, expect, it } from "vitest";
import { buildOverview, type InsightInput } from "../src/debug/insights";
import type { RequestTrace, RouteMetrics, Span } from "../src/debug/types";

const span = (id: number, name: string, durationMs = 1, parentId: number | null = 1): Span => ({
  id,
  parentId,
  name,
  kind: "db",
  startMs: id,
  durationMs,
  open: false,
  attrs: null,
  error: null,
  origin: null,
});

const trace = (id: string, overrides: Partial<RequestTrace> = {}): RequestTrace => ({
  id,
  ts: 100,
  startedAtMs: 0,
  durationMs: 10,
  method: "GET",
  path: `/${id}`,
  route: `/${id}`,
  status: 200,
  requestId: id,
  ip: "127.0.0.1",
  error: null,
  errorStack: null,
  request: { method: "GET", url: `http://x/${id}`, headers: {}, body: null },
  responseHeaders: null,
  responseBody: null,
  responseBodyTruncated: false,
  spans: [],
  dbTimeMs: 0,
  dbCount: 0,
  stages: [],
  ...overrides,
});

const route = (overrides: Partial<RouteMetrics> = {}): RouteMetrics => ({
  key: "GET /users",
  requests: 10,
  errors: 0,
  totalMs: 100,
  p50Ms: 5,
  p95Ms: 10,
  p99Ms: 20,
  dbQueries: 0,
  dbMs: 0,
  lastStatus: 200,
  lastTs: 100,
  ...overrides,
});

const input = (overrides: Partial<InsightInput> = {}): InsightInput => ({
  traces: [],
  metrics: {
    startedAt: 0,
    uptimeSec: 10,
    totals: {
      requests: 0,
      errors: 0,
      status2xx: 0,
      status3xx: 0,
      status4xx: 0,
      status5xx: 0,
      dbQueries: 0,
    },
    gauges: {},
    counters: [],
    routes: [],
    durationBucketsMs: [],
  },
  diagnostics: {
    verdict: "ok",
    checkedAt: 100,
    windowMin: 0,
    samplesAnalyzed: 0,
    findings: [],
    trend: {
      heapMiBPerMin: 0,
      heapR2: 0,
      heapNowMiB: 0,
      heapMinMiB: 0,
      heapMaxMiB: 0,
      rssMiBPerMin: 0,
      eventLoopP95Ms: 0,
      activeRequestsMax: 0,
    },
  },
  logs: { total: 0, debug: 0, info: 0, warn: 0, error: 0 },
  activeRequests: 0,
  systemSamples: 0,
  persistence: { enabled: false, error: null },
  checkedAt: 100,
  ...overrides,
});

describe("application insights", () => {
  it("starts with an explicit empty/uncovered state", () => {
    const overview = buildOverview(input());
    expect(overview.verdict).toBe("ok");
    expect(overview.findings).toEqual([]);
    expect(overview.summary.requests).toBe(0);
    expect(overview.coverage).toMatchObject({ retainedTraces: 0, persistence: "off" });
  });

  it("counts plain 5xx responses as failures and links to the latest one", () => {
    const overview = buildOverview(
      input({ traces: [trace("bad", { status: 503, durationMs: 40 }), trace("ok")] }),
    );
    expect(overview.summary).toMatchObject({ failures: 1, serverErrors: 1, failureRatePct: 50 });
    expect(overview.recentFailures[0]).toMatchObject({ id: "bad", status: 503 });
    expect(overview.findings[0]).toMatchObject({
      id: "request-failures",
      severity: "warning",
      link: { view: "detail", id: "bad", tab: "error" },
    });
  });

  it("escalates repeated failures and surfaces error logs", () => {
    const overview = buildOverview(
      input({
        traces: [
          trace("a", { status: 500 }),
          trace("b", { error: "boom", status: 500 }),
          trace("c", { status: 502 }),
        ],
        logs: { total: 4, debug: 0, info: 2, warn: 1, error: 1 },
      }),
    );
    expect(overview.verdict).toBe("critical");
    expect(overview.findings.map((finding) => finding.id)).toContain("error-logs");
    expect(overview.summary.logErrors).toBe(1);
  });

  it("detects a slow request window only with enough samples", () => {
    const tooSmall = buildOverview(input({ traces: [trace("one", { durationMs: 5000 })] }));
    expect(tooSmall.findings.some((finding) => finding.id === "slow-request-window")).toBe(false);

    const overview = buildOverview(
      input({
        traces: [
          trace("slow", { durationMs: 3200 }),
          trace("b", { durationMs: 100 }),
          trace("c", { durationMs: 100 }),
        ],
      }),
    );
    expect(overview.findings.find((finding) => finding.id === "slow-request-window")).toMatchObject(
      {
        severity: "critical",
        evidence: { p95Ms: 3200 },
      },
    );
  });

  it("detects slow route tails from route histograms", () => {
    const overview = buildOverview(
      input({
        metrics: { ...input().metrics, routes: [route({ p95Ms: 800, p99Ms: 1200 })] },
      }),
    );
    expect(
      overview.findings.find((finding) => finding.id === "slow-route:GET /users"),
    ).toMatchObject({
      severity: "warning",
      evidence: { p95Ms: 800, p99Ms: 1200 },
      link: { view: "metrics" },
    });
    expect(overview.slowRoutes[0]?.key).toBe("GET /users");
  });

  it("detects repeated top-level queries as N+1 but ignores nested wire spans", () => {
    const repeated = trace("users", {
      dbCount: 3,
      dbTimeMs: 30,
      spans: [
        span(2, "SELECT * FROM users WHERE id = ?"),
        span(3, "SELECT * FROM   users WHERE id = ?"),
        span(4, "select * from users where id = ?"),
      ],
    });
    const overview = buildOverview(input({ traces: [repeated] }));
    expect(
      overview.findings.find((finding) => finding.id === "repeated-query:users"),
    ).toMatchObject({
      category: "database",
      evidence: { repetitions: 3, requestQueries: 3 },
      link: { view: "detail", id: "users", tab: "queries" },
    });

    const nestedOnly = trace("nested", {
      spans: [span(2, "SELECT 1", 1, null), span(3, "SELECT 1", 1, 2), span(4, "SELECT 1", 1, 2)],
    });
    expect(
      buildOverview(input({ traces: [nestedOnly] })).findings.some((finding) =>
        finding.id.startsWith("repeated-query:"),
      ),
    ).toBe(false);
  });

  it("detects slow queries and retains measured evidence", () => {
    const overview = buildOverview(
      input({
        traces: [
          trace("report", { dbCount: 1, dbTimeMs: 400, spans: [span(2, "SELECT report", 400)] }),
        ],
      }),
    );
    expect(overview.findings.find((finding) => finding.id === "slow-query:report")).toMatchObject({
      evidence: { queryMs: 400, requestDbMs: 400 },
    });
  });

  it("includes runtime and persistence failures with control-panel links", () => {
    const base = input();
    const overview = buildOverview(
      input({
        diagnostics: {
          ...base.diagnostics,
          verdict: "critical",
          findings: [
            {
              id: "heap-growth",
              severity: "critical",
              title: "Heap climbing",
              detail: "Measured growth",
              evidence: { slopeMiBPerMin: 5 },
              recommendation: "Run GC",
            },
          ],
        },
        persistence: { enabled: true, error: "disk full" },
      }),
    );
    expect(overview.findings.find((finding) => finding.id === "heap-growth")?.link?.view).toBe(
      "diagnostics",
    );
    expect(overview.findings.find((finding) => finding.id === "persistence-error")?.detail).toBe(
      "disk full",
    );
    expect(overview.coverage.persistence).toBe("error");
  });
});
