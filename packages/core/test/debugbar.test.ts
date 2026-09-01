/**
 * Debugbar tests — tracer, store, profiler and the plugin end-to-end.
 *
 * The plugin is exercised through `createApp` in BOTH shapes the runtime
 * supports:
 *   - AOT-style (no router): `onRequest` intercepts `/__debugbar*` (the same
 *     path the compiled server takes via `__fallback`'s pre-stage run).
 *   - Interpreted (with a router): the dashboard routes are registered and
 *     `onRequest` passes through.
 */

import { describe, expect, it, vi } from "vitest";
import {
  beginTrace,
  debugQuery,
  debugSpan,
  enterTraceContext,
  NOOP_DEBUG_API,
  redactRequestTrace,
  SystemProfiler,
  setTracingEnabled,
  TraceStore,
} from "../src/debug/index.js";
import { createContext } from "../src/http/context.js";
import { createRouter } from "../src/http/router.js";
import { createApp } from "../src/index.js";
import { debugbar } from "../src/plugins/debugbar.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

/** A fake Bun server that re-enters the app (mirrors `server.fetch`). */
const loopingServer = (app: { handler(req: Request, srv?: unknown): Promise<Response> }) => ({
  requestIP: () => null,
  fetch: (r: Request) => app.handler(r, server),
});
let server: { requestIP(): null; fetch(r: Request): Promise<Response> };

const run = (
  app: { handler(req: Request, srv?: unknown): Promise<Response> },
  path: string,
  init: RequestInit = {},
) => app.handler(req(path, init), server);

// ── tracer ─────────────────────────────────────────────────────

describe("Trace", () => {
  it("records nested spans with correct timing and parentage", async () => {
    const ctx = createContext(req("/products/1"), {}, { route: "/products/:id" });
    const trace = beginTrace(ctx, false);
    const root = trace.root;
    expect(root.kind).toBe("request");
    expect(root.parentId).toBeNull();

    await trace.span("handler", "lifecycle", async () => {
      await trace.span("db: SELECT", "db", async () => {
        await sleep(2);
      });
      await sleep(1);
    });

    const json = trace.toJSON();
    expect(json.spans.length).toBe(3);
    const handler = json.spans.find((s) => s.name === "handler");
    const db = json.spans.find((s) => s.name === "db: SELECT");
    expect(handler?.parentId).toBe(0);
    expect(db?.parentId).toBe(handler?.id);
    expect(db?.durationMs).toBeGreaterThanOrEqual(1.5);
    expect(db?.kind).toBe("db");
    expect(json.dbCount).toBe(1);
    expect(json.dbTimeMs).toBeGreaterThanOrEqual(1);
  });

  it("records span failures without losing the error", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    await expect(
      trace.span("risky", "custom", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const json = trace.toJSON();
    const risky = json.spans.find((s) => s.name === "risky");
    expect(risky?.error).toBe("boom");
    expect(json.error).toBeNull(); // no request-level error yet
  });

  it("finalize is idempotent and fixes open spans", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    const _handle = trace.start("leak", "custom"); // left open deliberately
    await sleep(1);
    const first = await trace.finalize({ status: 200, responseHeaders: null, captureBody: false });
    const second = await trace.finalize({ status: 200, responseHeaders: null, captureBody: false });
    expect(second.id).toBe(first.id);
    const leak = second.spans.find((s) => s.name === "leak");
    expect(leak?.open).toBe(false);
    expect(leak?.error).toContain("left open");
  });

  it("recordStage is idempotent; finalize never flags the root or stage rows", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    trace.recordStage("request");
    trace.recordStage("request"); // idempotent — one row only
    const _handler = trace.start("handler", "lifecycle"); // still open at finalize
    await sleep(1);
    const json = await trace.finalize({ status: 200, responseHeaders: null, captureBody: false });

    // The root is the request itself — it must never show "span left open".
    expect(json.spans.find((s) => s.id === 0)?.error).toBeNull();
    // Framework stage rows close without the leak flag (the debugbar finalizes
    // inside the afterHandle stage while framework spans are still open).
    const rows = json.spans.filter((s) => s.kind === "lifecycle");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.name).toBe("request");
    expect(rows[0]?.startMs).toBe(0);
    const handler = json.spans.find((s) => s.name === "handler");
    expect(handler?.open).toBe(false);
    expect(handler?.error).toBeNull();
  });

  it("request-level errors carry a stack and mark the trace", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    trace.recordError(new Error("kaboom"));
    const json = trace.toJSON();
    expect(json.error).toBe("kaboom");
    expect(json.errorStack).toBeTruthy();
  });

  it("captures response bodies with a size cap (setResponseBody)", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);

    trace.setResponseBody('{"hello":"world"}');
    let json = trace.toJSON();
    expect(json.responseBody).toBe('{"hello":"world"}');
    expect(json.responseBodyTruncated).toBe(false);

    // Oversized bodies are clipped at the capture cap and flagged.
    const huge = "x".repeat(300_000);
    trace.setResponseBody(huge);
    json = trace.toJSON();
    expect(json.responseBody?.length).toBeLessThanOrEqual(262_144);
    expect(json.responseBodyTruncated).toBe(true);

    // Empty bodies store as null (204/304-style responses).
    trace.setResponseBody("");
    json = trace.toJSON();
    expect(json.responseBody).toBeNull();
    expect(json.responseBodyTruncated).toBe(false);
  });
});

describe("free helpers (ALS propagation)", () => {
  it("debugSpan/debugQuery attach to the trace entered for the request", async () => {
    // Simulate the plugin having installed ALS tracing (normally done at
    // `debugbar()` construction).
    setTracingEnabled(true);
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    enterTraceContext(trace);
    await debugSpan("outer", "custom", async () => {
      await debugQuery("SELECT 1", [], async () => {
        await sleep(1);
        return 1;
      });
    });
    const json = trace.toJSON();
    expect(json.spans.some((s) => s.name === "outer")).toBe(true);
    expect(json.spans.some((s) => s.name === "SELECT 1" && s.kind === "db")).toBe(true);
  });

  it("debugQuery records the result shape (row count + preview) on the span", async () => {
    setTracingEnabled(true);
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    enterTraceContext(trace);

    await debugQuery("SELECT * FROM users", [], async () => [{ id: 1 }, { id: 2 }, { id: 3 }]);
    await debugQuery("INSERT INTO users VALUES (1)", [1], async () => ({
      changes: 1,
      lastInsertRowid: 5,
    }));
    await debugQuery("SELECT fail", [], async () => {
      throw new Error("no such table");
    }).catch(() => {}); // the error is recorded AND rethrown

    const json = trace.toJSON();
    const select = json.spans.find((s) => s.name === "SELECT * FROM users");
    expect(select?.attrs).toMatchObject({ rowCount: 3 });
    expect(String(select?.attrs?.preview)).toContain('"id":1');

    const insert = json.spans.find((s) => s.name.startsWith("INSERT INTO"));
    expect(insert?.attrs).toMatchObject({ changes: 1, lastInsertRowid: 5 });

    const failed = json.spans.find((s) => s.name === "SELECT fail");
    expect(failed?.error).toBe("no such table");
  });

  it("helpers are pass-throughs with no active trace", async () => {
    const value = await debugSpan("nope", "custom", async () => 42);
    expect(value).toBe(42);
    const q = await debugQuery("SELECT 1", [], async () => 7);
    expect(q).toBe(7);
  });
});

describe("NOOP_DEBUG_API", () => {
  it("executes work without recording and without throwing", async () => {
    const out: string[] = [];
    await NOOP_DEBUG_API.span("a", "custom", async () => {
      out.push("ran");
    });
    await NOOP_DEBUG_API.query("SELECT 1", [], async () => out.push("q"));
    const handle = NOOP_DEBUG_API.start("m", "custom");
    handle.end();
    handle.endWithError(new Error("ignored"));
    NOOP_DEBUG_API.cache(true, "c", 1);
    NOOP_DEBUG_API.event("e");
    NOOP_DEBUG_API.error(new Error("ignored"));
    expect(out).toEqual(["ran", "q"]);
  });
});

describe("redactRequestTrace", () => {
  it("redacts sensitive headers while keeping the trace replayable raw", async () => {
    const ctx = createContext(
      req("/", { headers: { authorization: "Bearer secret", "x-custom": "kept" } }),
      {},
      {},
    );
    const trace = beginTrace(ctx, false);
    const raw = trace.toJSON();
    expect(raw.request.headers.authorization).toBe("Bearer secret");
    const redacted = redactRequestTrace(raw);
    expect(redacted.request.headers.authorization).toBe("[redacted]");
    expect(redacted.request.headers["x-custom"]).toBe("kept");
  });
});

describe("buildCurl", () => {
  it("renders method, URL, headers and body as a reproducible command", async () => {
    const { buildCurl } = await import("../src/debug/curl");
    const curl = buildCurl({
      method: "POST",
      request: {
        method: "POST",
        url: "http://localhost:3000/orders",
        headers: { authorization: "[redacted]", "content-type": "application/json" },
        body: '{"orderId":"7"}',
      },
    });
    expect(curl).toContain("-X POST");
    expect(curl).toContain("'http://localhost:3000/orders'");
    expect(curl).toContain("-H 'authorization: [redacted]'");
    expect(curl).toContain('--data-raw \'{"orderId":"7"}\'');
  });

  it("single-quote-escapes values containing quotes", async () => {
    const { buildCurl } = await import("../src/debug/curl");
    const curl = buildCurl({
      method: "GET",
      request: {
        method: "GET",
        url: "http://localhost:3000/search",
        headers: { "x-note": "it's here" },
        body: null,
      },
    });
    expect(curl).toContain(`it'\\''s here`);
    expect(curl).not.toContain("--data-raw");
  });

  it("skips hop-by-hop headers", async () => {
    const { buildCurl } = await import("../src/debug/curl");
    const curl = buildCurl({
      method: "GET",
      request: {
        method: "GET",
        url: "http://localhost:3000/",
        headers: { host: "localhost:3000", connection: "keep-alive", accept: "*/*" },
        body: null,
      },
    });
    expect(curl).not.toContain("-H 'host:");
    expect(curl).not.toContain("-H 'connection:");
    expect(curl).toContain("accept: */*");
  });
});

// ── store ──────────────────────────────────────────────────────

describe("TraceStore", () => {
  const makeTrace = (id: string, error: string | null) => ({
    id,
    ts: 1,
    startedAtMs: 1,
    durationMs: 10,
    method: "GET",
    path: `/${id}`,
    route: "",
    status: error ? 500 : 200,
    requestId: id,
    ip: "1.2.3.4",
    error,
    errorStack: null,
    request: { method: "GET", url: "http://localhost:3000/", headers: {}, body: null },
    responseHeaders: null,
    responseBody: null,
    responseBodyTruncated: false,
    spans: [],
    dbTimeMs: 0,
    dbCount: 0,
    stages: [],
  });

  it("drops the oldest trace when full", () => {
    const store = new TraceStore({ maxTraces: 3 });
    for (let i = 0; i < 5; i++) store.push(makeTrace(`r${i}`, null));
    expect(store.size).toBe(3);
    expect(store.list().map((t) => t.id)).toEqual(["r4", "r3", "r2"]);
    expect(store.get("r0")).toBeUndefined();
  });

  it("indexes errors and clears", () => {
    const store = new TraceStore();
    store.push(makeTrace("ok", null));
    store.push(makeTrace("bad", "boom"));
    expect(store.errorCount).toBe(1);
    expect(store.errors().map((t) => t.id)).toEqual(["bad"]);
    expect(store.summaries({ errorOnly: true }).map((s) => s.id)).toEqual(["bad"]);
    store.clear();
    expect(store.size).toBe(0);
    expect(store.errorCount).toBe(0);
  });

  it("computes duration percentiles", () => {
    const store = new TraceStore();
    for (let i = 1; i <= 100; i++) store.push(makeTrace(`r${i}`, null));
    const p = store.percentiles();
    expect(p.avgMs).toBeGreaterThan(9);
    expect(p.p95Ms).toBeLessThanOrEqual(100);
  });

  it("sheds bodies oldest-first when the body budget fills (spans survive)", () => {
    const body = "b".repeat(10_000);
    const fatTrace = (id: string): ReturnType<typeof makeTrace> => ({
      ...makeTrace(id, null),
      request: { method: "POST", url: "http://localhost:3000/", headers: {}, body },
      responseBody: body,
      responseBodyTruncated: false,
    });
    // Budget fits ~4 traces' worth of bodies (40 KiB total budget).
    const store = new TraceStore({ maxBodyBytes: 40_000 });
    for (let i = 1; i <= 8; i++) store.push(fatTrace(`r${i}`));

    expect(store.retainedBodyBytes).toBeLessThanOrEqual(40_000);
    // Oldest captures shed their body text…
    const old = store.get("r1");
    expect(old?.request.body).toBeNull();
    expect(old?.responseBody).toBeNull();
    // …but their spans/metadata survive.
    expect(old?.id).toBe("r1");
    expect(old?.path).toBe("/r1");
    // The newest capture keeps its bodies (it just arrived).
    expect(store.get("r8")?.request.body).toBe(body);
    expect(store.get("r8")?.responseBody).toBe(body);

    // Ring eviction keeps the accounting exact after turnover.
    for (let i = 9; i <= 12; i++) store.push(fatTrace(`r${i}`));
    expect(store.size).toBeLessThanOrEqual(store.maxTraces);
    let recomputed = 0;
    for (const t of store.list()) {
      recomputed += (t.request.body?.length ?? 0) + (t.responseBody?.length ?? 0);
    }
    expect(store.retainedBodyBytes).toBe(recomputed);
    expect(store.retainedBodyBytes).toBeLessThanOrEqual(40_000);
    store.clear();
    expect(store.retainedBodyBytes).toBe(0);
  });
});

// ── system profiler ────────────────────────────────────────────

describe("SystemProfiler", () => {
  it("samples CPU and memory on start, and stops cleanly", () => {
    const profiler = new SystemProfiler({ sampleMs: 5 });
    profiler.start();
    profiler.setActiveRequests(3);
    const stats = profiler.stats();
    expect(stats.sampling).toBe(true);
    expect(stats.samples.length).toBeGreaterThan(0);
    expect(stats.samples[0]).toHaveProperty("cpuPct");
    expect(stats.samples[0]).toHaveProperty("rssMiB");
    profiler.stop();
    expect(profiler.stats().sampling).toBe(false);
  });
});

// ── plugin: AOT-style (no router) ──────────────────────────────

describe("debugbar plugin (AOT-style interception)", () => {
  it("traces requests and serves the dashboard + APIs", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true, captureBody: true })],
      handler: async (ctx) => {
        await ctx.debug.span("do work", "custom", async () => {
          await sleep(1);
        });
        return ctx.json({ hello: "world" });
      },
    });
    server = loopingServer(app);

    // A normal request gets traced.
    const res = await run(app, "/hello");
    expect(await res.text()).toBe(JSON.stringify({ hello: "world" }));

    // The dashboard API lists it.
    const listRes = await run(app, "/__debugbar/api/requests");
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as Array<{ id: string; path: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].path).toBe("/hello");

    // Detail includes the span tree.
    const detailRes = await run(app, `/__debugbar/api/requests/${rows[0].id}`);
    const detail = (await detailRes.json()) as {
      spans: Array<{
        id: number;
        name: string;
        kind: string;
        startMs: number;
        error: string | null;
      }>;
      stages: string[];
    };
    expect(detail.spans.some((s) => s.name === "do work")).toBe(true);
    expect(detail.stages).toContain("request");

    // The waterfall gets automatic lifecycle stage rows: the request stage,
    // the handler (which wraps the app's own spans), and the post stages — so
    // a request without explicit ctx.debug calls still shows where time went.
    const stageNames = detail.spans.filter((s) => s.kind === "lifecycle").map((s) => s.name);
    expect(stageNames).toContain("request");
    expect(stageNames).toContain("handler");
    expect(stageNames).toContain("afterHandle");
    const handler = detail.spans.find((s) => s.name === "handler");
    expect(handler?.startMs).toBeGreaterThanOrEqual(0);
    // App spans nest inside the handler row.
    const work = detail.spans.find((s) => s.name === "do work");
    expect(work?.id).not.toBe(handler?.id);
    // The request-stage row starts at the trace start (it is what created the
    // trace), and no span is falsely flagged as leaked.
    const requestStage = detail.spans.find((s) => s.name === "request");
    expect(requestStage?.startMs).toBe(0);
    for (const s of detail.spans) expect(s.error).toBeNull();

    // Meta, HTML shell and app.js are served.
    const meta = await run(app, "/__debugbar/api/meta");
    expect((await meta.json()) as { debugMode: boolean }).toEqual(
      expect.objectContaining({ debugMode: true }),
    );
    const html = await run(app, "/__debugbar/");
    expect(html.headers.get("content-type")).toContain("text/html");
    const htmlText = await html.text();
    expect(htmlText).toContain("IgnEx Debugbar");
    // The shell links the stylesheet; the app and stylesheet are served.
    expect(htmlText).toContain("/app.css");
    const js = await run(app, "/__debugbar/app.js");
    expect(await js.text()).toContain("waterfall");
    // The app script must be executable: a JS MIME type, never text/html
    // (strict MIME checking refuses `text/html` scripts).
    expect(js.headers.get("content-type")).toContain("javascript");
    const css = await run(app, "/__debugbar/app.css");
    expect(css.headers.get("content-type")).toContain("text/css");
    expect(await css.text()).toContain("--bg");

    // Bare mount path redirects to the trailing slash.
    const redir = await run(app, "/__debugbar", { redirect: "manual" });
    expect(redir.status).toBe(307);
    expect(redir.headers.get("location")).toBe("/__debugbar/");
  });

  it("supports q/method/status request filters and exposes meta fields", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        if (ctx.method === "GET" && ctx.url.pathname === "/health") {
          return ctx.json({ ok: true });
        }
        if (ctx.method === "POST") {
          return ctx.json({ created: true });
        }
        return ctx.json({ nope: 404 }, { status: 404 });
      },
    });
    server = loopingServer(app);

    await run(app, "/health");
    await run(app, "/orders", { method: "POST" });
    await run(app, "/missing");
    const list = async (
      qs: string,
    ): Promise<Array<{ method: string; path: string; status: number }>> =>
      (await (await run(app, `/__debugbar/api/requests${qs}`)).json()) as Array<{
        method: string;
        path: string;
        status: number;
      }>;

    // q filters on method+path+error.
    const byQ = await list("?q=orders");
    expect(byQ.length).toBe(1);
    expect(byQ[0]?.method).toBe("POST");

    // method filter is exact.
    const byMethod = await list("?method=GET");
    expect(byMethod.every((r) => r.method === "GET")).toBe(true);

    // status family filter.
    const byStatus = await list("?status=4xx");
    expect(byStatus.every((r) => Math.floor(r.status / 100) === 4)).toBe(true);
    expect(byStatus.length).toBe(1);

    // Meta exposes native availability + buffer size.
    const meta = (await (await run(app, "/__debugbar/api/meta")).json()) as {
      nativeAvailable: boolean;
      bufferSize: number;
    };
    expect(typeof meta.nativeAvailable).toBe("boolean");
    expect(meta.bufferSize).toBe(3);
  });

  it("captures request bodies and replays the request through the server", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true, captureBody: true })],
      handler: async (ctx) => {
        if (ctx.method === "POST") {
          const body = await ctx.req.text();
          return ctx.json({ echo: body, doubled: body + body });
        }
        return ctx.json({ ok: true });
      },
    });
    server = loopingServer(app);

    await run(app, "/submit", { method: "POST", body: "payload-123" });
    const rows = (await (await run(app, "/__debugbar/api/requests")).json()) as Array<{
      id: string;
      method: string;
    }>;
    const post = rows.find((r) => r.method === "POST");
    expect(post).toBeTruthy();

    const detail = (await (await run(app, `/__debugbar/api/requests/${post?.id}`)).json()) as {
      request: { body: string };
    };
    expect(detail.request.body).toBe("payload-123");

    // Replay re-issues the exact request and returns the fresh result.
    const replayRes = await run(app, `/__debugbar/api/requests/${post?.id}/replay`, {
      method: "POST",
    });
    const replay = (await replayRes.json()) as {
      ok: boolean;
      status: number;
      body: string;
    };
    expect(replay.ok).toBe(true);
    expect(replay.status).toBe(200);
    expect(JSON.parse(replay.body)).toEqual({
      echo: "payload-123",
      doubled: "payload-123payload-123",
    });
  });

  it("captures request AND response bodies by default (and skips streams)", async () => {
    const sseStarted: (() => void) | null = null;
    const app = createApp({
      plugins: [debugbar({ enabled: true })], // captureBody defaults to ON
      handler: async (ctx) => {
        if (ctx.method === "POST" && ctx.url.pathname === "/echo") {
          const body = (await ctx.req.json()) as { msg: string };
          return ctx.json({ got: body.msg, n: 42 });
        }
        if (ctx.url.pathname === "/stream") {
          // An SSE-style infinite stream must NOT be awaited by the tracer.
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode("data: hi\n\n"));
                sseStarted?.();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return ctx.json({ ok: true });
      },
    });
    server = loopingServer(app);

    const payload = JSON.stringify({ msg: "hello bodies" });
    const res = await run(app, "/echo", { method: "POST", body: payload });
    // The client still receives the full, unmodified response.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: "hello bodies", n: 42 });

    const rows = (await (await run(app, "/__debugbar/api/requests")).json()) as Array<{
      id: string;
      method: string;
      path: string;
    }>;
    const post = rows.find((r) => r.path === "/echo");
    expect(post).toBeTruthy();

    const detail = (await (await run(app, `/__debugbar/api/requests/${post?.id}`)).json()) as {
      request: { body: string | null };
      responseBody: string | null;
      responseBodyTruncated: boolean;
    };
    expect(detail.request.body).toBe(payload);
    expect(detail.responseBody).toBe('{"got":"hello bodies","n":42}');
    expect(detail.responseBodyTruncated).toBe(false);

    // SSE responses are skipped (never awaited) and the stream still flows.
    const streamRes = await run(app, "/stream");
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    const reader = streamRes.body?.getReader();
    const chunk = await reader?.read();
    expect(new TextDecoder().decode(chunk?.value)).toContain("data: hi");
    await reader?.cancel();

    await sleep(20);
    const streamRows = (await (await run(app, "/__debugbar/api/requests")).json()) as Array<{
      id: string;
      path: string;
    }>;
    const streamed = streamRows.find((r) => r.path === "/stream");
    if (streamed) {
      // The stream trace is stored, but its body was never captured.
      const streamDetail = (await (
        await run(app, `/__debugbar/api/requests/${streamed.id}`)
      ).json()) as { responseBody: string | null };
      expect(streamDetail.responseBody).toBeNull();
    }
  });

  it("captures db queries with results through the per-request debug API", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        const rows = (await ctx.debug.query("SELECT id FROM orders", [], async () => [
          { id: "o1" },
          { id: "o2" },
        ])) as Array<{ id: string }>;
        return ctx.json({ count: rows.length });
      },
    });
    server = loopingServer(app);

    await run(app, "/orders");
    const rows = (await (await run(app, "/__debugbar/api/requests")).json()) as Array<{
      id: string;
      dbCount: number;
    }>;
    expect(rows[0]?.dbCount).toBe(1);
    const detail = (await (await run(app, `/__debugbar/api/requests/${rows[0]?.id}`)).json()) as {
      dbTimeMs: number;
      spans: Array<{ kind: string; name: string; attrs: Record<string, unknown> | null }>;
    };
    const query = detail.spans.find((s) => s.kind === "db");
    expect(query?.name).toBe("SELECT id FROM orders");
    expect(query?.attrs?.rowCount).toBe(2);
    expect(String(query?.attrs?.preview)).toContain("o1");
    expect(detail.dbTimeMs).toBeGreaterThanOrEqual(0);
  });

  it("captures handler errors with stacks and lists them", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async () => {
        throw new Error("handler exploded");
      },
    });
    server = loopingServer(app);

    const res = await run(app, "/explode");
    expect(res.status).toBe(500);
    const rows = (await (await run(app, "/__debugbar/api/requests?error=1")).json()) as Array<{
      id: string;
      error: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].error).toBe("handler exploded");
    const detail = (await (await run(app, `/__debugbar/api/requests/${rows[0].id}`)).json()) as {
      errorStack: string | null;
      status: number;
    };
    expect(detail.status).toBe(500);
    expect(detail.errorStack).toBeTruthy();
  });

  it("serves system stats and KT knowledge", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true, serviceName: "demo" })],
      handler: () => new Response("ok"),
    });
    server = loopingServer(app);
    await run(app, "/a");
    await run(app, "/b");

    const sys = (await (await run(app, "/__debugbar/api/system")).json()) as {
      totals: { requests: number };
      sampling: boolean;
    };
    expect(sys.totals.requests).toBe(2);

    const kt = (await (await run(app, "/__debugbar/api/kt")).json()) as {
      markdown: string;
      knowledge: {
        serviceName: string;
        routes: unknown[];
        areas: Array<{ name: string }>;
        docs: Array<{ path: string; title: string }>;
        dbActions: unknown[];
      };
    };
    expect(kt.knowledge.serviceName).toBe("demo");
    expect(kt.markdown).toContain("Request anatomy");
    expect(kt.markdown).toContain("debugbar");
    // New-developer onboarding sections are always present.
    expect(kt.markdown).toContain("Where things live");
    expect(kt.markdown).toContain("Database activity");
    expect(kt.markdown).toContain("Documentation");
    expect(Array.isArray(kt.knowledge.dbActions)).toBe(true);
  });

  it("KT documents the DB actions observed across retained requests", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true })],
      handler: async (ctx) => {
        if (ctx.url.pathname === "/users") {
          await ctx.debug.query(
            "SELECT id, name FROM users WHERE active = 1 LIMIT 20",
            [],
            async () => [{ id: 1 }],
          );
        }
        return ctx.json({ ok: true });
      },
    });
    server = loopingServer(app);
    await run(app, "/users");
    await run(app, "/users"); // second call → calls == 2

    const kt = (await (await run(app, "/__debugbar/api/kt")).json()) as {
      markdown: string;
      knowledge: {
        dbActions: Array<{
          action: string;
          table: string | null;
          statement: string;
          calls: number;
          totalMs: number;
          routes: string[];
        }>;
      };
    };
    const action = kt.knowledge.dbActions.find((a) => a.table === "users");
    expect(action).toBeTruthy();
    expect(action?.action).toBe("SELECT");
    expect(action?.calls).toBe(2);
    // Literals are normalized away so the pattern is stable.
    expect(action?.statement).toBe("SELECT id, name FROM users WHERE active = ? LIMIT ?");
    expect(action?.routes.length).toBeGreaterThan(0);
    // And the markdown table renders it.
    expect(kt.markdown).toContain("SELECT id, name FROM users WHERE active = ? LIMIT ?");
  });

  it("KT lists the project's documentation from the configured scan paths", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "ignex-kt-docs-"));
    writeFileSync(join(dir, "README.md"), "# Demo Service\n\nThe entry point doc.\n", "utf8");
    writeFileSync(join(dir, "architecture.md"), "# System architecture\n", "utf8");
    const sub = join(dir, "guides");
    (await import("node:fs")).mkdirSync(sub);
    writeFileSync(join(sub, "auth.md"), "# Auth guide\nHow sessions work.\n", "utf8");

    const app = createApp({
      plugins: [debugbar({ enabled: true, docsPaths: [dir], manifestPaths: [], sdkPaths: [] })],
      handler: () => new Response("ok"),
    });
    server = loopingServer(app);
    await run(app, "/x");

    const kt = (await (await run(app, "/__debugbar/api/kt")).json()) as {
      knowledge: { docs: Array<{ path: string; title: string }> };
    };
    const doc = (suffix: string) => kt.knowledge.docs.find((d) => d.path.endsWith(suffix));
    // Titles come from each file's first `#` heading.
    expect(doc("architecture.md")?.title).toBe("System architecture");
    expect(doc("auth.md")?.title).toBe("Auth guide");
    expect(doc("guides/auth.md")).toBeTruthy();
    // README sorts first and its title comes from the heading.
    expect(kt.knowledge.docs[0]?.path.endsWith("README.md")).toBe(true);
    expect(kt.knowledge.docs[0]?.title).toBe("Demo Service");
    rmSync(dir, { recursive: true, force: true });
  });

  it("enforces the token when configured", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true, token: "sekrit" })],
      handler: () => new Response("ok"),
    });
    server = loopingServer(app);
    await run(app, "/x");

    const denied = await run(app, "/__debugbar/api/requests");
    expect(denied.status).toBe(403);
    // Query-string tokens are rejected on API endpoints (they leak into
    // access logs/referrers) — the page handshake converts them into a cookie.
    const queryToken = await run(app, "/__debugbar/api/requests?token=sekrit");
    expect(queryToken.status).toBe(403);
    const headerOk = await run(app, "/__debugbar/api/requests", {
      headers: { "x-debugbar-token": "sekrit" },
    });
    expect(headerOk.status).toBe(200);
  });

  it("converts a ?token= page visit into an HttpOnly cookie and strips the token from the URL", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: true, token: "sekrit" })],
      handler: () => new Response("ok"),
    });
    server = loopingServer(app);
    await run(app, "/x");

    const handshake = await run(app, "/__debugbar/?token=sekrit");
    expect(handshake.status).toBe(307);
    expect(handshake.headers.get("location")).toBe("/__debugbar/");
    const setCookie = handshake.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("__debugbar_token=sekrit");
    expect(setCookie).toContain("HttpOnly");
    // A wrong token still gets the dashboard 403.
    const wrong = await run(app, "/__debugbar/?token=nope");
    expect(wrong.status).toBe(403);
    // The cookie authenticates subsequent API calls.
    const viaCookie = await run(app, "/__debugbar/api/requests", {
      headers: { cookie: "__debugbar_token=sekrit" },
    });
    expect(viaCookie.status).toBe(200);
    // The static JS asset stays reachable for the page to load (no token
    // gate) and is served as executable JavaScript, not text/html.
    const js = await run(app, "/__debugbar/app.js");
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
  });

  it("is inert when disabled (no dashboard, no tracing overhead)", async () => {
    const app = createApp({
      plugins: [debugbar({ enabled: false })],
      handler: () => new Response("ok"),
    });
    server = loopingServer(app);
    const res = await run(app, "/fine");
    expect(await res.text()).toBe("ok");
    // No router: the disabled plugin passes everything through to the handler.
    const dash = await run(app, "/__debugbar/");
    expect(await dash.text()).toBe("ok");
  });

  it("marks itself __ignexDevOnly when disabled (compiled server drops it)", () => {
    // The compiled server filters plugins with `__ignexDevOnly === true` out
    // of the runtime lifecycle, so a disabled dev tool costs zero per-request
    // hooks. The marker must exactly mirror the enabled state.
    expect(debugbar({ enabled: false }).__ignexDevOnly).toBe(true);
    expect(debugbar({ enabled: true }).__ignexDevOnly).toBe(false);
  });

  it("never boots in production unless IGNEX_DEBUG=1 explicitly opts in", () => {
    const origNodeEnv = process.env.NODE_ENV;
    const origIgnExDebug = process.env.IGNEX_DEBUG;
    try {
      delete process.env.IGNEX_DEBUG;

      // Production + explicit enabled:true → forced off (stray DEBUG=true
      // env files must not ship the toolbar into production).
      process.env.NODE_ENV = "production";
      const warns: string[] = [];
      const spy = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
        warns.push(args.map(String).join(" "));
      });
      try {
        expect(debugbar({ enabled: true }).__ignexDevOnly).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(warns.some((l) => l.includes("IGNEX_DEBUG=1"))).toBe(true);

      // Production + IGNEX_DEBUG=1 → explicit opt-in works.
      process.env.IGNEX_DEBUG = "1";
      expect(debugbar({ enabled: true }).__ignexDevOnly).toBe(false);
      expect(debugbar().__ignexDevOnly).toBe(false);
      expect(debugbar({ enabled: false }).__ignexDevOnly).toBe(true);
    } finally {
      if (origNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = origNodeEnv;
      if (origIgnExDebug === undefined) delete process.env.IGNEX_DEBUG;
      else process.env.IGNEX_DEBUG = origIgnExDebug;
    }
  });

  it("treats a production-built artifact (__IGNEX_PROD_BUILD) as production even with an ambiguous env", () => {
    const origIgnExDebug = process.env.IGNEX_DEBUG;
    delete process.env.NODE_ENV;
    delete process.env.IGNEX_DEBUG;
    const g = globalThis as { __IGNEX_PROD_BUILD?: boolean };
    try {
      // Prod-BUILT artifact launched bare (no NODE_ENV): locked off.
      g.__IGNEX_PROD_BUILD = true;
      expect(debugbar({ enabled: true }).__ignexDevOnly).toBe(true);

      // Explicit IGNEX_DEBUG=1 opt-in unlocks it.
      process.env.IGNEX_DEBUG = "1";
      expect(debugbar({ enabled: true }).__ignexDevOnly).toBe(false);
    } finally {
      delete g.__IGNEX_PROD_BUILD;
      if (origIgnExDebug === undefined) delete process.env.IGNEX_DEBUG;
      else process.env.IGNEX_DEBUG = origIgnExDebug;
    }
  });

  it("logs the dashboard URL on init, and the exact URL on the first request", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const app = createApp({
        plugins: [debugbar({ enabled: true })],
        handler: () => new Response("ok"),
      });
      await app.init();
      expect(logs.some((l) => l.includes("debugbar") && l.includes("/__debugbar/"))).toBe(true);

      // A real server with a URL that differs from the boot hint (http, custom
      // port) → the exact URL is logged on the first traced request.
      const exactLogs = logs.length;
      server = { ...loopingServer(app), url: "http://127.0.0.1:3999/" };
      await run(app, "/hello");
      const urlLine = logs.slice(exactLogs).find((l) => l.includes("debugbar"));
      expect(urlLine).toContain("http://127.0.0.1:3999/__debugbar/");
    } finally {
      spy.mockRestore();
    }
  });
});

// ── plugin: interpreted (router) ───────────────────────────────

describe("debugbar plugin (interpreted router)", () => {
  it("registers dashboard routes on the router and traces through them", async () => {
    const router = createRouter()
      .get("/health", (ctx) => ctx.json({ ok: true }))
      .post("/orders", async (ctx) => {
        await ctx.debug.query("INSERT INTO orders (payload) VALUES (?)", ["x"], async () => {
          await sleep(1);
        });
        return ctx.json({ created: true });
      });
    const app = createApp({
      router,
      plugins: [debugbar({ enabled: true })],
    });
    server = loopingServer(app);

    const ok = await run(app, "/health");
    expect(ok.status).toBe(200);

    const created = await run(app, "/orders", { method: "POST" });
    expect(created.status).toBe(200);

    const rows = (await (await run(app, "/__debugbar/api/requests")).json()) as Array<{
      id: string;
      path: string;
      dbCount: number;
    }>;
    expect(rows.length).toBe(2);
    const order = rows.find((r) => r.path === "/orders");
    expect(order?.dbCount).toBe(1);

    // The router path records lifecycle stage rows too (request, handler,
    // afterHandle) — the db query nests inside the handler row.
    const detail = (await (await run(app, `/__debugbar/api/requests/${order?.id}`)).json()) as {
      spans: Array<{ id: number; name: string; kind: string }>;
    };
    const stageNames = detail.spans.filter((s) => s.kind === "lifecycle").map((s) => s.name);
    expect(stageNames).toContain("request");
    expect(stageNames).toContain("handler");
    expect(stageNames).toContain("afterHandle");
    const handler = detail.spans.find((s) => s.name === "handler");
    const query = detail.spans.find((s) => s.name === "INSERT INTO orders (payload) VALUES (?)");
    expect(handler?.id).toBeDefined();
    expect(query?.id).not.toBe(handler?.id);

    // Dashboard served through the router route.
    const dash = await run(app, "/__debugbar/");
    expect((await dash.text()) as string).toContain("IgnEx Debugbar");

    // Router path also serves app.js with an executable JS MIME type.
    const routerJs = await run(app, "/__debugbar/app.js");
    expect(routerJs.status).toBe(200);
    expect(routerJs.headers.get("content-type")).toContain("javascript");

    // KT built from the router's registrations.
    const kt = (await (await run(app, "/__debugbar/api/kt")).json()) as {
      knowledge: { routes: Array<{ path: string }> };
    };
    const paths = kt.knowledge.routes.map((r) => r.path);
    expect(paths).toContain("/health");
    expect(paths).toContain("/orders");
  });
});

// ── jobs + routes panels ────────────────────────────────────────

describe("debugbar data panels", () => {
  it("serves /api/jobs from an injected job store", async () => {
    const plugin = debugbar({
      enabled: true,
      path: "/__debugbar",
      data: {
        jobs: {
          list: async () => [
            { name: "send-email", status: "completed", runAt: Date.now() },
            { name: "send-email", status: "queued", runAt: Date.now() + 1000 },
          ],
        },
      },
    });
    const app = createApp({
      plugins: [plugin],
      router: createRouter(),
      handler: () => new Response("ok"),
    });
    const res = await run(app, "/__debugbar/api/jobs");
    const body = (await res.json()) as {
      enabled: boolean;
      total: number;
      byStatus: Record<string, number>;
    };
    expect(body.enabled).toBe(true);
    expect(body.total).toBe(2);
    expect(body.byStatus).toMatchObject({ completed: 1, queued: 1 });
  });

  it("serves /api/routes from an injected provider", async () => {
    const plugin = debugbar({
      enabled: true,
      path: "/__debugbar",
      data: {
        routes: async () => [{ method: "GET", path: "/health", file: "health.get.ts" }],
      },
    });
    const app = createApp({
      plugins: [plugin],
      router: createRouter(),
      handler: () => new Response("ok"),
    });
    const res = await run(app, "/__debugbar/api/routes");
    const body = (await res.json()) as { enabled: boolean; routes: Array<{ path: string }> };
    expect(body.enabled).toBe(true);
    expect(body.routes).toHaveLength(1);
    expect(body.routes[0]?.path).toBe("/health");
  });

  it("reports jobs as disabled when no store is wired", async () => {
    const plugin = debugbar({ enabled: true, path: "/__debugbar" });
    const app = createApp({
      plugins: [plugin],
      router: createRouter(),
      handler: () => new Response("ok"),
    });
    const res = await run(app, "/__debugbar/api/jobs");
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("serves the nova event trace (what fired) from a wired handle", async () => {
    let cleared = 0;
    const plugin = debugbar({
      enabled: true,
      path: "/__debugbar",
      data: {
        nova: () => ({
          getEventTrace: (opts?: { limit?: number; direction?: string; name?: string }) => ({
            enabled: true,
            capacity: 1024,
            stats: {
              size: 2,
              total: 3,
              inCount: 1,
              outCount: 2,
              bytes: 64,
              byName: { "quote.tick": 2, chat: 1 },
              last: { name: "quote.tick", ts: 1720000000000 },
            },
            recent:
              opts?.direction !== undefined
                ? [
                    {
                      seq: 2,
                      ts: 1720000000000,
                      direction: "out.emit",
                      name: "quote.tick",
                      target: "user",
                      key: "u-42",
                      bytes: 32,
                    },
                  ]
                : [
                    {
                      seq: 2,
                      ts: 1720000000000,
                      direction: "out.emit",
                      name: "quote.tick",
                      target: "user",
                      key: "u-42",
                      bytes: 32,
                    },
                    {
                      seq: 1,
                      ts: 1720000000000,
                      direction: "in.client",
                      name: "chat",
                      bytes: 32,
                    },
                  ],
          }),
          clearEventTrace: () => {
            cleared++;
          },
        }),
      },
    });
    const app = createApp({
      plugins: [plugin],
      router: createRouter(),
      handler: () => new Response("ok"),
    });

    const res = await run(app, "/__debugbar/api/nova/events?limit=50&direction=out.emit");
    const body = (await res.json()) as {
      enabled: boolean;
      stats: { byName: Record<string, number> };
      recent: Array<{ name: string; target?: string }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.stats.byName).toMatchObject({ "quote.tick": 2 });
    // filters reach the underlying trace (out.emit-only → the chat row drops)
    expect(body.recent).toHaveLength(1);
    expect(body.recent[0]?.name).toBe("quote.tick");
    expect(body.recent[0]?.target).toBe("user");

    const clearRes = await run(app, "/__debugbar/api/nova/events/clear", { method: "POST" });
    expect(((await clearRes.json()) as { ok: boolean }).ok).toBe(true);
    expect(cleared).toBe(1);

    // the AI summary carries the compact nova block for agents
    const summary = (await (await run(app, "/__debugbar/api/ai/summary")).json()) as {
      nova?: { enabled: boolean; outCount: number; recent: Array<{ name: string }> };
    };
    expect(summary.nova?.enabled).toBe(true);
    expect(summary.nova?.outCount).toBe(2);
    expect(summary.nova?.recent[0]?.name).toBe("quote.tick");
  });

  it("reports nova as not wired when no data.nova probe is configured", async () => {
    const plugin = debugbar({ enabled: true, path: "/__debugbar" });
    const app = createApp({
      plugins: [plugin],
      router: createRouter(),
      handler: () => new Response("ok"),
    });
    const res = await run(app, "/__debugbar/api/nova/events");
    const body = (await res.json()) as { enabled: boolean; hint?: string };
    expect(body.enabled).toBe(false);
    expect(body.hint).toContain("data.nova");

    // and a throwing probe degrades to the same disabled state
    const broken = debugbar({
      enabled: true,
      path: "/__db2",
      data: {
        nova: () => {
          throw new Error("probe exploded");
        },
      },
    });
    const app2 = createApp({
      plugins: [broken],
      router: createRouter(),
      handler: () => new Response("ok"),
    });
    const res2 = await run(app2, "/__db2/api/nova/events");
    expect(((await res2.json()) as { enabled: boolean }).enabled).toBe(false);
  });
});
