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

  it("request-level errors carry a stack and mark the trace", async () => {
    const ctx = createContext(req("/"), {}, {});
    const trace = beginTrace(ctx, false);
    trace.recordError(new Error("kaboom"));
    const json = trace.toJSON();
    expect(json.error).toBe("kaboom");
    expect(json.errorStack).toBeTruthy();
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
      spans: Array<{ name: string; kind: string }>;
      stages: string[];
    };
    expect(detail.spans.some((s) => s.name === "do work")).toBe(true);
    expect(detail.stages).toContain("request");

    // Meta, HTML shell and app.js are served.
    const meta = await run(app, "/__debugbar/api/meta");
    expect((await meta.json()) as { debugMode: boolean }).toEqual(
      expect.objectContaining({ debugMode: true }),
    );
    const html = await run(app, "/__debugbar/");
    expect(html.headers.get("content-type")).toContain("text/html");
    expect(await html.text()).toContain("IgnEx Debugbar");
    const js = await run(app, "/__debugbar/app.js");
    expect(await js.text()).toContain("waterfall");

    // Bare mount path redirects to the trailing slash.
    const redir = await run(app, "/__debugbar", { redirect: "manual" });
    expect(redir.status).toBe(307);
    expect(redir.headers.get("location")).toBe("/__debugbar/");
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
      knowledge: { serviceName: string; routes: unknown[] };
    };
    expect(kt.knowledge.serviceName).toBe("demo");
    expect(kt.markdown).toContain("Request anatomy");
    expect(kt.markdown).toContain("debugbar");
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
    const allowed = await run(app, "/__debugbar/api/requests?token=sekrit");
    expect(allowed.status).toBe(200);
    const headerOk = await run(app, "/__debugbar/api/requests", {
      headers: { "x-debugbar-token": "sekrit" },
    });
    expect(headerOk.status).toBe(200);
    // The static JS asset stays reachable for the page to load.
    const js = await run(app, "/__debugbar/app.js");
    expect(js.status).toBe(200);
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

    // Dashboard served through the router route.
    const dash = await run(app, "/__debugbar/");
    expect((await dash.text()) as string).toContain("IgnEx Debugbar");

    // KT built from the router's registrations.
    const kt = (await (await run(app, "/__debugbar/api/kt")).json()) as {
      knowledge: { routes: Array<{ path: string }> };
    };
    const paths = kt.knowledge.routes.map((r) => r.path);
    expect(paths).toContain("/health");
    expect(paths).toContain("/orders");
  });
});
