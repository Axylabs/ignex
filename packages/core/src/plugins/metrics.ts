/**
 * @fileoverview `metricsPlugin` + `createOtlpExporter` — production
 * observability: a `/metrics` Prometheus endpoint, per-request HTTP metrics,
 * and an optional OTLP/HTTP JSON push exporter for metrics.
 *
 * This is DX over standard protocols (Prometheus text and OTLP/HTTP JSON),
 * not a new monitoring system. The plugin:
 *
 *   - counts requests per route/status and records duration histograms;
 *   - serves `GET /metrics` in Prometheus text format (auth via a token
 *     option — metrics endpoints should not be public);
 *   - `createOtlpExporter(metrics, { endpoint })` pushes snapshots on an
 *     interval with timeouts, non-overlapping exports, and async shutdown.
 *
 * ```ts
 * import { metricsPlugin } from "@ignex/core";
 * export const plugins = [metricsPlugin({ path: "/metrics", token: process.env.METRICS_TOKEN })];
 * ```
 */
import { timingSafeEqual } from "node:crypto";
import type { IgnexContext } from "../http/context";
import type { IgnexRouter } from "../http/router";
import type { IgnexPlugin } from "../lifecycle/plugin";
import { createMetrics, type Metrics } from "../platform/metrics";

/** Options for {@link metricsPlugin}. */
export interface MetricsPluginOptions {
  /** Route to serve the Prometheus exposition on (default `/metrics`). */
  path?: string;
  /** Bearer token required to read /metrics (default none — restrict at the proxy). */
  token?: string;
  /** A pre-built registry (default: a fresh one). */
  metrics?: Metrics;
}

/** Create the metrics plugin. */
export const metricsPlugin = (
  options: MetricsPluginOptions = {},
): IgnexPlugin & {
  metrics: Metrics;
} => {
  const metrics = options.metrics ?? createMetrics();
  const path = options.path ?? "/metrics";
  const token = options.token;
  const expectedAuthorization = token === undefined ? null : Buffer.from(`Bearer ${token}`);

  // NOTE: one metric NAME must have ONE label shape (Prometheus data model).
  // The registry enforces this strictly, so the per-request counters carry
  // their labels here and there is no second unlabeled series with the same
  // name. Totals are `sum by(name)` on the scraper side.
  // The duration family auto-creates on first observe (per-route series); no
  // pre-declaration so /metrics stays free of zero-filled placeholder series.

  const authorized = (req: Request): boolean => {
    if (expectedAuthorization === null) return true;
    const supplied = Buffer.from(req.headers.get("authorization") ?? "");
    return (
      supplied.length === expectedAuthorization.length &&
      timingSafeEqual(supplied, expectedAuthorization)
    );
  };

  return {
    name: "metrics",
    version: "0.1.0",
    metrics,

    routes(router: IgnexRouter) {
      router.get(path, (ctx) => {
        if (!authorized(ctx.req)) {
          return new Response("unauthorized", { status: 401 });
        }
        return new Response(metrics.renderPrometheus(), {
          headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
        });
      });
    },

    onRequest(ctx: IgnexContext) {
      // Interpreted + AOT both route through onRequest; we record on the
      // response side where the status is known.
      const start = performance.now();
      (ctx as unknown as { __metricsStart?: number }).__metricsStart = start;
      return ctx;
    },

    onResponse(ctx: IgnexContext, response: Response) {
      const start = (ctx as unknown as { __metricsStart?: number }).__metricsStart;
      const elapsed = start !== undefined ? performance.now() - start : 0;
      const route = ctx.route ? String(ctx.route) : "unknown";
      const status = String(response.status);
      // Hint-addressed hot lane: the composed hint IS the series address, so
      // each event costs one Map hit + arithmetic (no label-key building).
      metrics
        .counter("ignex_http_requests_total", { route, status }, `${route}\u001f${status}`)
        .inc();
      metrics
        .counter("ignex_http_errors_total", { route, status }, `${route}\u001f${status}e`)
        .inc(response.status >= 500 ? 1 : 0);
      metrics.histogram("ignex_http_request_duration_ms", { route }, route).observe(elapsed);
      return response;
    },
  };
};

/** Options for {@link createOtlpExporter}. */
export interface OtlpExporterOptions {
  /** OTLP endpoint (e.g. `http://collector:4318/v1/metrics`). */
  endpoint: string;
  /** Push interval in ms (default 15_000). */
  intervalMs?: number;
  /** Maximum duration of one export request in ms (default 10_000). */
  timeoutMs?: number;
  /** Optional headers (auth). */
  headers?: Record<string, string>;
  /** Service name label (default `process.env.OTEL_SERVICE_NAME` or "ignex"). */
  serviceName?: string;
}

interface OtlpExporter {
  start(): void;
  /** Stop scheduled exports and wait for any active request. */
  stop(): Promise<void>;
}

const otlpAttributes = (labels: Record<string, string>) =>
  Object.entries(labels).map(([key, value]) => ({ key, value: { stringValue: value } }));

const otlpPayload = (metrics: Metrics, serviceName: string): Record<string, unknown> => {
  const snapshot = metrics.snapshot();
  const counters = snapshot.counters.map((counter) => ({
    name: counter.name,
    unit: "1",
    sum: {
      dataPoints: [
        {
          attributes: otlpAttributes(counter.labels),
          ...(Number.isInteger(counter.value)
            ? { asInt: String(counter.value) }
            : { asDouble: counter.value }),
        },
      ],
      aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
      isMonotonic: true,
    },
  }));
  const histograms = snapshot.histograms.map((histogram) => ({
    name: histogram.name,
    unit: "ms",
    histogram: {
      dataPoints: [
        {
          attributes: otlpAttributes(histogram.labels),
          count: String(histogram.count),
          sum: histogram.sum,
          bucketCounts: [
            ...histogram.buckets.map((bucket) => String(bucket.count)),
            String(histogram.count),
          ],
          explicitBounds: histogram.buckets.map((bucket) => bucket.le),
        },
      ],
      aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE",
    },
  }));
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
        scopeMetrics: [{ scope: { name: "ignex" }, metrics: [...counters, ...histograms] }],
      },
    ],
  };
};

/** Push standards-shaped OTLP/HTTP JSON metric snapshots without overlapping exports. */
export const createOtlpExporter = (
  metrics: Metrics,
  options: OtlpExporterOptions,
): OtlpExporter => {
  const intervalMs = options.intervalMs ?? 15_000;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "ignex";
  let timer: ReturnType<typeof setInterval> | null = null;
  let active: Promise<void> | null = null;

  const push = (): Promise<void> => {
    if (active) return active;
    active = (async () => {
      try {
        const response = await fetch(options.endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: JSON.stringify(otlpPayload(metrics, serviceName)),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok) throw new Error(`collector returned ${response.status}`);
      } catch (error) {
        console.error(
          `[otlp] push failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    })().finally(() => {
      active = null;
    });
    return active;
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void push(), intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = null;
      await active;
    },
  };
};
