/**
 * Observatory unit tests — LogStore + debugLog, console capture,
 * MetricsRegistry (+ Prometheus exposition), LeakDetector analysis,
 * TraceStore filter extensions and the SystemProfiler sample hook.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeLogStore,
  analyzeSamples,
  captureConsole,
  debugLog,
  installLogStore,
  LogStore,
  linearTrend,
  MetricsRegistry,
  SystemProfiler,
  TraceStore,
  uninstallLogStore,
} from "../src/debug/index.js";
import { beginTrace, enterTraceContext, setTracingEnabled } from "../src/debug/tracer.js";
import type { RequestTrace, SystemSample } from "../src/debug/types.js";
import { createContext } from "../src/http/context.js";

/* ── factories ────────────────────────────────────────────────── */

let clock = 1_700_000_000_000;
const sample = (over: Partial<SystemSample> = {}): SystemSample => {
  clock += 1000;
  return {
    ts: clock,
    cpuPct: 5,
    rssMiB: 80,
    heapMiB: 50,
    eventLoopDelayMs: 2,
    activeRequests: 1,
    ...over,
  };
};

const trace = (over: Partial<RequestTrace> = {}): RequestTrace => ({
  id: `req-${Math.random().toString(36).slice(2, 8)}`,
  ts: Date.now(),
  startedAtMs: 0,
  durationMs: 10,
  method: "GET",
  path: "/x",
  route: "/x",
  status: 200,
  requestId: `reqid-${Math.random().toString(36).slice(2, 6)}`,
  ip: "127.0.0.1",
  error: null,
  errorStack: null,
  request: { method: "GET", url: "http://localhost/x", headers: {}, body: null },
  responseHeaders: null,
  responseBody: null,
  responseBodyTruncated: false,
  spans: [],
  dbTimeMs: 0,
  dbCount: 0,
  stages: ["request"],
  ...over,
});

afterEach(() => {
  uninstallLogStore();
  setTracingEnabled(false);
  vi.restoreAllMocks();
});

/* ── LogStore ─────────────────────────────────────────────────── */

describe("LogStore", () => {
  it("retains a bounded ring and reports per-level stats", () => {
    const store = new LogStore({ maxRecords: 3 });
    for (let i = 0; i < 5; i++) store.push({ level: "info", message: `m${i}` });
    expect(store.size).toBe(3);
    const rows = store.list();
    expect(rows.map((r) => r.message)).toEqual(["m4", "m3", "m2"]);
    const stats = store.stats();
    expect(stats.total).toBe(3);
    expect(stats.info).toBe(3);
    store.push({ level: "error", message: "boom" });
    expect(store.stats().error).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("filters by min level, text, trace id and time window", () => {
    const store = new LogStore();
    store.push({ level: "debug", message: "noise" });
    store.push({ level: "warn", message: "slow query on /users" });
    store.push({ level: "error", message: "DB down", traceId: "req-a" });
    expect(store.list({ minLevel: "warn" }).length).toBe(2);
    expect(store.list({ q: "users" })[0]?.level).toBe("warn");
    expect(store.list({ traceId: "req-a" }).length).toBe(1);
    const now = Date.now();
    expect(store.list({ since: now - 1 }).length).toBe(3);
    expect(store.list({ until: now - 60_000 }).length).toBe(0);
    expect(store.list({ limit: 1 }).length).toBe(1);
  });

  it("notifies the persistence sink for every record and survives throwing sinks", () => {
    const store = new LogStore();
    const seen: string[] = [];
    store.setSink((r) => {
      seen.push(r.message);
      if (r.message === "explode") throw new Error("sink down");
    });
    store.push({ level: "info", message: "one" });
    store.push({ level: "info", message: "explode" });
    expect(seen).toEqual(["one", "explode"]);
    expect(store.size).toBe(2);
  });
});

describe("installLogStore + debugLog", () => {
  it("correlates free-helper logs to the active request trace", () => {
    setTracingEnabled(true);
    const ctx = createContext(
      new Request("http://localhost:3000/products/1"),
      {},
      { route: "/products/:id" },
    );
    const tr = beginTrace(ctx, false);
    enterTraceContext(tr);
    const store = installLogStore(new LogStore());
    debugLog("warn", "halfway there", { step: 2 });
    const rec = store.list()[0];
    expect(rec?.traceId).toBe(tr.id);
    expect(rec?.requestId).toBe(tr.toJSON().requestId);
    expect(rec?.source).toBe("app");
    expect(rec?.attrs).toEqual({ step: 2 });
  });

  it("is a no-op when no store is installed", () => {
    expect(activeLogStore()).toBeUndefined();
    expect(() => debugLog("error", "invisible")).not.toThrow();
  });
});

describe("captureConsole", () => {
  it("mirrors console calls into the store and still passes them through", () => {
    const store = new LogStore();
    const spy = vi.spyOn(console, "warn");
    const restore = captureConsole(store);
    console.warn("careful", { code: 7 });
    restore();
    spy.mockRestore();

    const rec = store.list()[0];
    expect(rec?.level).toBe("warn");
    expect(rec?.source).toBe("console");
    expect(rec?.message).toContain("careful");
    expect(rec?.message).toContain('{"code":7}');
    // The wrapper was removed: calling again records nothing more.
    console.warn("after restore");
    expect(store.size).toBe(1);
  });
});

/* ── MetricsRegistry ──────────────────────────────────────────── */

describe("MetricsRegistry", () => {
  it("aggregates per-route requests, statuses and duration quantiles", () => {
    // Exact-value buckets so quantiles are deterministic in assertions.
    const metrics = new MetricsRegistry({ durationBucketsMs: [10, 20, 30, 40, 50] });
    for (const ms of [10, 20, 30, 40, 50]) {
      metrics.observeRequest({
        method: "GET",
        routeKey: "GET /users",
        status: 200,
        durationMs: ms,
        dbQueries: 1,
        dbMs: ms / 10,
      });
    }
    metrics.observeRequest({
      method: "GET",
      routeKey: "GET /missing",
      status: 404,
      durationMs: 2,
      error: true,
    });

    const snap = metrics.snapshot();
    expect(snap.totals.requests).toBe(6);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.status2xx).toBe(5);
    expect(snap.totals.status4xx).toBe(1);

    const users = snap.routes.find((r) => r.key === "GET /users");
    expect(users?.p50Ms).toBe(30);
    expect(users?.p95Ms).toBe(50);
    expect(users?.dbQueries).toBe(5);
    // Busiest route first.
    expect(snap.routes[0]?.key).toBe("GET /users");

    // Snapshot histogram counts are cumulative (le semantics).
    const users2 = metrics.routeRows()[0];
    expect(users2?.requests).toBe(5);
  });

  it("tracks gauges from system samples and custom counters", () => {
    const metrics = new MetricsRegistry();
    metrics.observeSystem(sample({ heapMiB: 42.5 }));
    expect(metrics.snapshot().gauges.process_heap_used_mib).toBeCloseTo(42.5);
    metrics.incCounter("emails.sent", { kind: "welcome" });
    metrics.incCounter("emails.sent", { kind: "welcome" });
    metrics.incCounter("emails.sent", { kind: "digest" }, 3);
    const counters = metrics.snapshot().counters;
    expect(counters.find((c) => c.labels.kind === "welcome")?.value).toBe(2);
    expect(counters.find((c) => c.labels.kind === "digest")?.value).toBe(3);
  });

  it("renders valid Prometheus exposition with cumulative buckets", () => {
    const metrics = new MetricsRegistry();
    metrics.observeRequest({
      method: "POST",
      routeKey: 'POST /or"ders',
      status: 201,
      durationMs: 7,
    });
    metrics.observeRequest({
      method: "POST",
      routeKey: 'POST /or"ders',
      status: 500,
      durationMs: 9,
    });
    const text = metrics.prometheus();
    const escapedKey = 'POST /or\\"ders';
    expect(text).toContain("# TYPE ignex_http_requests_total counter");
    expect(text).toContain(`ignex_http_requests_total{route="${escapedKey}"} 2`);
    expect(text).toContain(`ignex_http_requests_errors_total{route="${escapedKey}"} 1`);
    // Both observations (7 ms and 9 ms) land in le=10; cumulative semantics.
    expect(text).toMatch(/ignex_http_request_duration_ms_bucket\{route=".+?",le="10"\} 2/);
    expect(text).toMatch(/ignex_http_request_duration_ms_bucket\{route=".+?",le="\+Inf"\} 2/);
    expect(text).toMatch(/ignex_http_request_duration_ms_count\{route=".+?"\} 2/);
    expect(text.endsWith("\n")).toBe(true);
  });
});

/* ── leak analysis ────────────────────────────────────────────── */

describe("analyzeSamples", () => {
  it("returns ok with too few samples", () => {
    const report = analyzeSamples([sample(), sample()]);
    expect(report.verdict).toBe("ok");
    expect(report.samplesAnalyzed).toBe(2);
  });

  it("stays calm on flat or noisy-but-flat memory", () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample({ heapMiB: 50 + Math.sin(i) * 3 }));
    const report = analyzeSamples(samples);
    expect(report.verdict).toBe("ok");
    expect(report.findings).toHaveLength(0);
  });

  it("detects sustained heap growth with severity scaled to the slope", () => {
    // ~2 MiB/min → warning.
    const warnSamples = Array.from({ length: 40 }, (_, i) =>
      sample({ ts: Date.now() - (40 - i) * 60_000, heapMiB: 40 + i * 2 }),
    );
    const warnReport = analyzeSamples(warnSamples);
    const warn = warnReport.findings.find((f) => f.id === "heap-growth");
    expect(warn?.severity).toBe("warning");
    expect(warnReport.verdict).toBe("warning");

    // ~6 MiB/min → critical, with full evidence attached.
    const critSamples = Array.from({ length: 40 }, (_, i) =>
      sample({ ts: Date.now() - (40 - i) * 60_000, heapMiB: 40 + i * 6 }),
    );
    const report = analyzeSamples(critSamples);
    const heap = report.findings.find((f) => f.id === "heap-growth");
    expect(heap?.severity).toBe("critical");
    expect(heap?.evidence.slopeMiBPerMin).toBeGreaterThan(4);
    expect(report.trend.heapMiBPerMin).toBeGreaterThan(4);
    expect(report.verdict).toBe("critical");
  });

  it("ignores short-window bursts (boot warm-up / ring fill-up)", () => {
    // The exact false-positive that shipped once: ~1.6 min of samples right
    // after boot climbing 19-22 MiB/min with R²=1. Too early to call.
    const now = Date.now();
    const burst = Array.from({ length: 96 }, (_, i) => {
      const frac = i / 95;
      return sample({
        ts: now - 96_000 + Math.round(frac * 96_000),
        heapMiB: 85.9 + frac * 31,
        rssMiB: 142.7 + frac * 36.9,
      });
    });
    const report = analyzeSamples(burst);
    const memFindings = report.findings.filter(
      (f) => f.id === "heap-growth" || f.id === "rss-growth",
    );
    expect(memFindings).toHaveLength(0);
    expect(report.verdict).not.toBe("critical");
  });

  it("downgrades a plateaued climb to info (growth already stopped)", () => {
    // 6 minutes total: climbs for the first half, then flat. The overall fit
    // is steep, but the recent tail proves the growth stopped.
    const now = Date.now();
    const plateau = Array.from({ length: 360 }, (_, i) => {
      const ts = now - 360_000 + i * 1000;
      const heap = i < 180 ? 50 + i * 0.5 : 140;
      return sample({ ts, heapMiB: heap });
    });
    const report = analyzeSamples(plateau);
    const heap = report.findings.find((f) => f.id === "heap-growth");
    if (heap) {
      expect(heap.severity).toBe("info");
      expect(heap.detail).toContain("flat");
      expect(heap.evidence.tailSlopeMiBPerMin).toBeLessThan(0.5);
    }
    expect(report.verdict).not.toBe("critical");
  });

  it("requires meaningful TOTAL growth, not just a steep slope", () => {
    // Slope above the warn threshold but only ~1.8 MiB over the window on a
    // large heap — noise, not a leak.
    const samples = Array.from({ length: 200 }, (_, i) =>
      sample({ ts: Date.now() - (200 - i) * 1000, heapMiB: 500 + i * 0.01 }),
    );
    const ids = analyzeSamples(samples).findings.map((f) => f.id);
    expect(ids).not.toContain("heap-growth");
  });

  it("flags RSS-only growth (native/buffer leaks)", () => {
    const samples = Array.from({ length: 30 }, (_, i) =>
      sample({ ts: Date.now() - (30 - i) * 60_000, rssMiB: 60 + i * 3 }),
    );
    const ids = analyzeSamples(samples).findings.map((f) => f.id);
    expect(ids).toContain("rss-growth");
  });

  it("raises event-loop saturation above the p95 threshold", () => {
    const samples = Array.from({ length: 20 }, () => sample({ eventLoopDelayMs: 60 }));
    const report = analyzeSamples(samples);
    const finding = report.findings.find((f) => f.id === "event-loop-saturation");
    expect(finding?.severity).toBe("warning"); // 60 >= 50, < 200

    // 4× over threshold escalates to critical.
    const crit = analyzeSamples(
      Array.from({ length: 20 }, () => sample({ eventLoopDelayMs: 250 })),
    );
    expect(crit.verdict).toBe("critical");
  });

  it("detects in-flight requests that never drain", () => {
    const samples = Array.from({ length: 30 }, (_, i) => sample({ activeRequests: 25 + i }));
    const report = analyzeSamples(samples);
    const finding = report.findings.find((f) => f.id === "active-requests-growth");
    expect(finding?.severity).toBe("warning");
  });

  it("linearTrend fits a clean line exactly", () => {
    const xs = [0, 1, 2, 3, 4];
    const fit = linearTrend(
      xs,
      xs.map((x) => 3 * x + 1),
    );
    expect(fit.slope).toBeCloseTo(3);
    expect(fit.r2).toBeCloseTo(1);
  });
});

/* ── TraceStore filters + profiler hook ───────────────────────── */

describe("TraceStore extended filters", () => {
  const store = new TraceStore();
  store.push(
    trace({ ts: 1_000, method: "GET", path: "/a", route: "/a", status: 200, durationMs: 5 }),
  );
  store.push(
    trace({
      ts: 2_000,
      method: "POST",
      path: "/b",
      route: "/b/:id",
      status: 500,
      durationMs: 900,
      error: "boom",
    }),
  );
  store.push(
    trace({ ts: 3_000, method: "GET", path: "/c", route: "/c", status: 200, durationMs: 400 }),
  );

  it("filters by time window, route substring and minimum duration", () => {
    expect(store.summaries({ since: 1_500 }).length).toBe(2);
    expect(store.summaries({ until: 2_000 }).length).toBe(2);
    expect(store.summaries({ route: ":id" }).length).toBe(1);
    expect(store.summaries({ minDurationMs: 300 }).length).toBe(2);
    expect(store.summaries({ method: "post" }).length).toBe(1);
    expect(store.summaries({ status: "5xx" }).length).toBe(1);
  });
});

describe("SystemProfiler onSample hook", () => {
  it("invokes observers with each fresh sample", async () => {
    const seen: SystemSample[] = [];
    const profiler = new SystemProfiler({
      sampleMs: 5,
      onSample: (s) => {
        seen.push(s);
        throw new Error("observers must never break sampling");
      },
    });
    profiler.start();
    await new Promise<void>((r) => setTimeout(r, 30));
    profiler.stop();
    expect(seen.length).toBeGreaterThan(0);
  });
});
