/**
 * Debugbar observatory endpoints — logs, metrics (+ Prometheus exposition),
 * diagnostics, state, history and meta feature flags, exercised end-to-end
 * through `createApp` (AOT-style interception).
 */

import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { debugbar } from "../src/plugins/debugbar.js";

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

const run = (
  app: { handler(req: Request, srv?: unknown): Promise<Response> },
  path: string,
  init: RequestInit = {},
) => app.handler(req(path, init));

const appWith = (
  options: Parameters<typeof debugbar>[0] = {},
  handler: Parameters<typeof createApp>[0]["handler"] = () => new Response("ok"),
): { handler(req: Request, srv?: unknown): Promise<Response> } =>
  createApp({
    plugins: [debugbar({ enabled: true, path: "/__debugbar", ...options })],
    handler,
  });

describe("observatory endpoints", () => {
  it("captures ctx.debug.log calls with trace correlation and serves /api/logs", async () => {
    const app = appWith({ persist: false }, async (ctx) => {
      ctx.debug.log("warn", "payment retry", { attempt: 2 });
      return ctx.json({ ok: true });
    });

    await run(app, "/pay");

    const res = await run(app, "/__debugbar/api/logs?level=warn");
    const body = (await res.json()) as {
      enabled: boolean;
      records: Array<{
        level: string;
        message: string;
        attrs: Record<string, unknown> | null;
        traceId: string | null;
        source: string;
      }>;
      stats: { warn: number; total: number };
    };
    expect(body.enabled).toBe(true);
    expect(body.stats.warn).toBe(1);
    const rec = body.records.find((r) => r.message === "payment retry");
    expect(rec).toBeDefined();
    expect(rec?.attrs).toEqual({ attempt: 2 });
    // Correlated to the request that emitted it.
    expect(rec?.traceId).toBeTruthy();

    // The correlated trace id resolves to a real stored trace.
    const listRes = await run(app, "/__debugbar/api/requests");
    const rows = (await listRes.json()) as Array<{ id: string; path: string }>;
    expect(rows[0]?.path).toBe("/pay");
    expect(rows[0]?.id).toBe(rec?.traceId);

    // Clear empties the ring.
    await run(app, "/__debugbar/api/logs/clear", { method: "POST" });
    const after = (await (await run(app, "/__debugbar/api/logs")).json()) as {
      records: unknown[];
      stats: { total: number };
    };
    expect(after.records).toHaveLength(0);
    expect(after.stats.total).toBe(0);
  });

  it("aggregates per-route metrics and exposes Prometheus text", async () => {
    const app = appWith({ persist: false }, (ctx) => {
      if (ctx.url.pathname === "/nope") return ctx.json({ nope: true }, { status: 404 });
      return ctx.json({ ok: true });
    });
    await run(app, "/orders");
    await run(app, "/orders");
    await run(app, "/nope", { method: "DELETE" });

    const res = await run(app, "/__debugbar/api/metrics");
    const snap = (await res.json()) as {
      totals: { requests: number; errors: number; status2xx: number; status4xx: number };
      routes: Array<{ key: string; requests: number; p50Ms: number }>;
    };
    expect(snap.totals.requests).toBe(3);
    expect(snap.totals.errors).toBe(1);
    expect(snap.totals.status2xx).toBe(2);
    expect(snap.totals.status4xx).toBe(1);
    const orders = snap.routes.find((r) => r.key.startsWith("GET /orders"));
    expect(orders?.requests).toBe(2);

    const prom = await run(app, "/__debugbar/api/metrics/prometheus");
    expect(prom.headers.get("content-type")).toContain("text/plain");
    const text = await prom.text();
    expect(text).toContain("# TYPE ignex_http_requests_total counter");
    expect(text).toMatch(/ignex_http_requests_total\{route="GET \/orders"\} 2/);
    expect(text).toMatch(/ignex_http_requests_errors_total\{route="DELETE \/nope"\} 1/);
    expect(text).toContain("# TYPE ignex_process_rss_mib gauge");
  });

  it("serves diagnostics and gc endpoints", async () => {
    const app = appWith({ persist: false });

    // No samples yet (profiler starts with init()) → healthy empty report.
    const diag = (await (await run(app, "/__debugbar/api/diagnostics")).json()) as {
      verdict: string;
      findings: unknown[];
      trend: { heapNowMiB: number };
      samplesAnalyzed: number;
      persist: { enabled: boolean };
    };
    expect(diag.verdict).toBe("ok");
    expect(diag.samplesAnalyzed).toBe(0);
    expect(Array.isArray(diag.findings)).toBe(true);
    // persist:false → sink never created.
    expect(diag.persist.enabled).toBe(false);

    const gc = (await (
      await run(app, "/__debugbar/api/diagnostics/gc", { method: "POST" })
    ).json()) as { ok: boolean; afterHeapUsedMiB: number };
    expect(gc.ok).toBe(true);
    expect(gc.afterHeapUsedMiB).toBeGreaterThanOrEqual(0);
    // GET on a POST endpoint is rejected.
    const wrongMethod = await run(app, "/__debugbar/api/diagnostics/gc");
    expect(wrongMethod.status).toBe(405);
  });

  it("serves the application state snapshot without env values", async () => {
    process.env.OBSERVATORY_TEST_VAR = "secret-value";
    const app = appWith({ persist: false, serviceName: "state-app" }, (ctx) =>
      ctx.json({ ok: true }),
    );
    await run(app, "/anything");

    const res = await run(app, "/__debugbar/api/state");
    const state = (await res.json()) as {
      service: string;
      memory: { rssMiB: number };
      envKeys: string[];
      stores: { tracesRetained: number };
      features: { logs: boolean; metrics: boolean; persist: boolean };
      plugins: string[];
    };
    expect(state.service).toBe("state-app");
    expect(state.memory.rssMiB).toBeGreaterThan(0);
    expect(state.stores.tracesRetained).toBe(1);
    expect(state.features.logs).toBe(true);
    expect(state.features.persist).toBe(false); // no init() in this harness
    // Names only — values must never appear.
    expect(state.envKeys).toContain("OBSERVATORY_TEST_VAR");
    expect(JSON.stringify(state)).not.toContain("secret-value");
    delete process.env.OBSERVATORY_TEST_VAR;
  });

  it("reports persistence off in meta/history when disabled or unopened", async () => {
    const appOff = appWith({ persist: false });
    const metaOff = (await (await run(appOff, "/__debugbar/api/meta")).json()) as {
      features: { history: boolean };
    };
    expect(metaOff.features.history).toBe(false);

    const histOff = (await (await run(appOff, "/__debugbar/api/history?q=x")).json()) as {
      enabled: boolean;
      rows: unknown[];
    };
    expect(histOff.enabled).toBe(false);
    expect(histOff.rows).toEqual([]);

    // With persistence configured but init() not yet fired, /api/history is
    // served by the same graceful path (sink still null).
    const appDefault = appWith({});
    const hist = (await (await run(appDefault, "/__debugbar/api/history")).json()) as {
      enabled: boolean;
    };
    expect(hist.enabled).toBe(false);

    // Persisted log reads degrade gracefully too.
    const logsPersisted = (await (
      await run(appDefault, "/__debugbar/api/logs?persisted=1")
    ).json()) as { available: boolean; records: unknown[] };
    expect(logsPersisted.available).toBe(false);
    expect(logsPersisted.records).toEqual([]);
  });

  it("history detail 404s for unknown ids", async () => {
    const app = appWith({ persist: false });
    const res = await run(app, "/__debugbar/api/history/nope-123");
    expect(res.status).toBe(404);
  });

  it("serves a syntactically valid dashboard app.js (observatory views wired)", async () => {
    const app = appWith({ persist: false });
    const res = await run(app, "/__debugbar/app.js");
    const js = await res.text();
    // Every observatory view must ship in the bundle — asserted via stable
    // user-facing strings (independent of minified symbol names).
    for (const marker of [
      "logs (window)", // Logs view
      "history rows", // History view
      "Per-route aggregates", // Metrics view
      "run full GC", // Diagnostics view
      "Environment variable names", // State view
      "publishing…", // Events composer
    ]) {
      expect(js).toContain(marker);
    }
    // Parse (without executing) when the bun transpiler is available.
    const Bun_ = (
      globalThis as {
        Bun?: { Transpiler?: new (o: { loader: string }) => { transformSync(s: string): string } };
      }
    ).Bun;
    if (Bun_?.Transpiler) {
      expect(() => new Bun_.Transpiler({ loader: "js" }).transformSync(js)).not.toThrow();
    }
  });
});
