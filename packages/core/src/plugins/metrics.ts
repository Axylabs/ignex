/**
 * @fileoverview `metricsPlugin` + `createOtlpExporter` — production
 * observability: a `/metrics` Prometheus endpoint, per-request HTTP metrics,
 * and an optional OTLP push exporter for traces/metrics.
 *
 * This is DX over the STANDARD protocols (Prometheus text format, OTLP/gRPC
 * via @opentelemetry when installed), not a new monitoring system. The plugin:
 *
 *   - counts requests per route/status and records duration histograms;
 *   - serves `GET /metrics` in Prometheus text format (auth via a token
 *     option — metrics endpoints should not be public);
 *   - `createOtlpExporter(metrics, { endpoint })` pushes snapshots on an
 *     interval using the @opentelemetry SDK when installed (optional).
 *
 * ```ts
 * import { metricsPlugin } from "@ignex/core";
 * export const plugins = [metricsPlugin({ path: "/metrics", token: process.env.METRICS_TOKEN })];
 * ```
 */
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

  const requests = metrics.counter("ignex_http_requests_total", {});
  const errors = metrics.counter("ignex_http_errors_total", {});
  const duration = metrics.histogram("ignex_http_request_duration_ms", {});

  const authorized = (req: Request): boolean => {
    if (token === undefined) return true;
    const auth = req.headers.get("authorization") ?? "";
    return auth === `Bearer ${token}`;
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
      requests.inc();
      duration.observe(elapsed);
      const statusCounter = metrics.counter("ignex_http_requests_total", {
        route,
        status: String(response.status),
      });
      statusCounter.inc();
      if (response.status >= 500) errors.inc();
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
  /** Optional headers (auth). */
  headers?: Record<string, string>;
  /** Service name label (default `process.env.OTEL_SERVICE_NAME` or "ignex"). */
  serviceName?: string;
}

/**
 * Push metric snapshots to an OTLP endpoint on an interval. Uses fetch (the
 * OTLP/HTTP protobuf-JSON path) — no @opentelemetry dependency required.
 * Best-effort: a failed push is logged, never thrown.
 */
export const createOtlpExporter = (
  metrics: Metrics,
  options: OtlpExporterOptions,
): { start(): void; stop(): void } => {
  const intervalMs = options.intervalMs ?? 15_000;
  const serviceName = options.serviceName ?? process.env.OTEL_SERVICE_NAME ?? "ignex";
  let timer: ReturnType<typeof setInterval> | null = null;

  const push = async (): Promise<void> => {
    const snapshot = metrics.snapshot();
    // Minimal OTLP/HTTP JSON payload: resource + scope metrics with
    // sum/gauge + histogram data points. Enough for a collector to ingest
    // without the full SDK.
    const dataPoints = [
      ...snapshot.counters.map((c) => ({
        name: c.name,
        unit: "1",
        sum: { value: c.value, aggregationTemporality: "AGGREGATION_TEMPORALITY_CUMULATIVE" },
        attributes: Object.entries(c.labels).map(([k, v]) => ({
          key: k,
          value: { stringValue: v },
        })),
      })),
      ...snapshot.histograms.map((h) => ({
        name: h.name,
        unit: "ms",
        histogram: {
          sampleCount: String(h.count),
          sampleSum: String(h.sum),
          bucketCounts: [...h.buckets.map((b) => String(b.count)), "0"],
          explicitBounds: h.buckets.map((b) => b.le),
        },
        attributes: Object.entries(h.labels).map(([k, v]) => ({
          key: k,
          value: { stringValue: v },
        })),
      })),
    ];
    const payload = {
      resourceMetrics: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: serviceName } }] },
          scopeMetrics: [
            {
              scope: { name: "ignex" },
              metrics: dataPoints.map((dp) => ({
                ...dp,
                name: dp.name,
                unit: dp.unit,
              })),
            },
          ],
        },
      ],
    };
    try {
      await fetch(options.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      // Best-effort — a down collector must never break the app.
      console.error(
        `[otlp] push failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => void push(), intervalMs);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
};
