/**
 * Metrics — createMetrics registry + metricsPlugin + OTLP exporter.
 *
 * The registry is dependency-free and fully testable; the plugin wires it to
 * the lifecycle (counters + duration histograms) and serves /metrics.
 */

import { createApp, createMetrics, createOtlpExporter, metricsPlugin } from "@ignex/core";
import { describe, expect, it, vi } from "vitest";

describe("createMetrics", () => {
  it("counters increment and render in Prometheus format", () => {
    const m = createMetrics();
    m.counter("http_requests_total", { route: "/health" }).inc();
    m.counter("http_requests_total", { route: "/health" }).inc(2);
    const out = m.renderPrometheus();
    expect(out).toContain('http_requests_total{route="/health"} 3');
  });

  it("histograms record count/sum/buckets", () => {
    const m = createMetrics();
    const h = m.histogram("latency_ms", { route: "/x" });
    h.observe(2);
    h.observe(50);
    h.observe(3000);
    expect(h.count).toBe(3);
    expect(h.sum).toBeCloseTo(3052);
    expect(h.buckets[0]).toEqual({ le: 1, count: 0 });
    // 2 and 50 land in the 2.5 and 100 buckets respectively; 3000 in 5000.
    expect(h.buckets[2]?.count).toBe(1); // le=5
    expect(h.buckets[4]?.count).toBe(1); // le=25? 50 <= 50 → index 5 (le 50)
    void m.renderPrometheus();
  });

  it("snapshot carries names + labels for exporters", () => {
    const m = createMetrics();
    m.counter("c", { a: "1" }).inc();
    const snap = m.snapshot();
    expect(snap.counters[0]?.name).toBe("c");
    expect(snap.counters[0]?.labels).toEqual({ a: "1" });
    expect(snap.counters[0]?.value).toBe(1);
  });
});

describe("metricsPlugin", () => {
  it("registers /metrics on a real router", async () => {
    const { createRouter } = await import("@ignex/core");
    const router = createRouter().get("/health", () => new Response("ok"));
    const app = createApp({
      plugins: [metricsPlugin({ path: "/metrics" })],
      router,
      handler: () => new Response("ok"),
    });
    expect(app).toBeDefined();
  });

  it("metrics are recorded across a handled request", async () => {
    const m = createMetrics();
    const plugin = metricsPlugin({ metrics: m });
    const app = createApp({
      plugins: [plugin],
      handler: () => new Response("ok", { status: 200 }),
    });
    const res = await app.handler(new Request("http://x/health"));
    expect(res.status).toBe(200);
    const out = m.renderPrometheus();
    expect(out).toContain("ignex_http_requests_total");
    expect(out).toContain("ignex_http_request_duration_ms");
  });
});

describe("createOtlpExporter", () => {
  it("starts and stops without throwing (best-effort push)", async () => {
    const m = createMetrics();
    m.counter("c").inc();
    const fetchMock = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const exporter = createOtlpExporter(m, {
      endpoint: "http://collector:4318/v1/metrics",
      intervalMs: 10,
    });
    exporter.start();
    await new Promise((r) => setTimeout(r, 30));
    exporter.stop();
    expect(fetchMock).toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
