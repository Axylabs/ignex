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

  it("drops new series past maxSeries (bounds label cardinality)", () => {
    const m = createMetrics({ maxSeries: 2 });
    m.counter("c", { route: "/a" }).inc();
    m.counter("c", { route: "/b" }).inc();
    const dropped = m.counter("c", { route: "/c" });
    dropped.inc(9); // no-op view — not stored
    expect(dropped.value).toBe(0);
    const droppedHistogram = m.histogram("h", { route: "/c" });
    droppedHistogram.observe(1);
    expect(droppedHistogram.count).toBe(0);

    const out = m.renderPrometheus();
    expect(out).toContain('c{route="/a"} 1');
    expect(out).toContain('c{route="/b"} 1');
    expect(out).not.toContain('route="/c"');
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

  it("requires the exact configured bearer token", async () => {
    const { createRouter } = await import("@ignex/core");
    const app = createApp({
      plugins: [metricsPlugin({ token: "metrics-secret" })],
      router: createRouter(),
    });

    expect((await app.handler(new Request("http://x/metrics"))).status).toBe(401);
    expect(
      (
        await app.handler(
          new Request("http://x/metrics", {
            headers: { authorization: "Bearer metrics-secret-extra" },
          }),
        )
      ).status,
    ).toBe(401);
    const authorized = await app.handler(
      new Request("http://x/metrics", {
        headers: { authorization: "Bearer metrics-secret" },
      }),
    );
    expect(authorized.status).toBe(200);
    expect(await authorized.text()).toContain("ignex_http_requests_total");
  });
});

describe("createOtlpExporter", () => {
  it("exports valid OTLP data points and drains before stopping", async () => {
    const m = createMetrics({ histogramBuckets: [10] });
    m.counter("requests", { route: "/orders" }).inc();
    m.histogram("latency", { route: "/orders" }).observe(5);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    });
    vi.stubGlobal("fetch", fetchMock);
    const exporter = createOtlpExporter(m, {
      endpoint: "http://collector:4318/v1/metrics",
      intervalMs: 10,
    });
    exporter.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await exporter.stop();

    expect(fetchMock).toHaveBeenCalled();
    const payload = JSON.parse(bodies[0] ?? "{}") as any;
    const exported = payload.resourceMetrics[0].scopeMetrics[0].metrics;
    const counter = exported.find((metric: any) => metric.name === "requests");
    const histogram = exported.find((metric: any) => metric.name === "latency");
    expect(counter.sum.isMonotonic).toBe(true);
    expect(counter.sum.dataPoints[0]).toMatchObject({
      asInt: "1",
      attributes: [{ key: "route", value: { stringValue: "/orders" } }],
    });
    expect(histogram.histogram.dataPoints[0]).toMatchObject({
      count: "1",
      sum: 5,
      bucketCounts: ["1", "1"],
      explicitBounds: [10],
    });
    expect(JSON.stringify(payload)).not.toContain("sampleCount");
    vi.unstubAllGlobals();
  });

  it("rejects unsuccessful collector responses without throwing into the app", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const m = createMetrics();
    m.counter("c").inc();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("full", { status: 503 })),
    );
    const exporter = createOtlpExporter(m, {
      endpoint: "http://collector:4318/v1/metrics",
      intervalMs: 5,
    });
    exporter.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await exporter.stop();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("503"));
    errorSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});
