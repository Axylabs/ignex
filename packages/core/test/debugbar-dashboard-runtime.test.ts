/**
 * Dashboard SPA runtime smoke — executes the SERVED bundle under happy-dom,
 * boots the app shell, drives every view through its keyboard shortcut plus
 * the hash-router navigation paths, and asserts nothing rendered an "… is not
 * defined" / ReferenceError panel.
 *
 * Executing the real code paths (not just a syntax check) is what caught
 * `v is not defined` inside renderHistory historically; this harness keeps
 * that whole bug class failing here instead of in a browser.
 */

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";

import { DEBUGBAR_CLIENT_JS } from "../src/debug/dashboard-client.gen.js";

/* ── browser-global stubs (timers + transports only; DOM is real) ──────── */

const NOW = Date.now();

const traceSample = {
  id: "t1",
  ts: NOW,
  startedAtMs: 0,
  durationMs: 5,
  method: "GET",
  path: "/",
  route: "GET /",
  status: 200,
  requestId: "r1",
  ip: "127.0.0.1",
  error: null,
  errorStack: null,
  request: { method: "GET", url: "http://x/", headers: {}, body: null },
  responseHeaders: {},
  responseBody: "{}",
  responseBodyTruncated: false,
  spans: [
    {
      id: 1,
      parentId: 0,
      name: "users.getOne",
      kind: "db",
      startMs: 1,
      durationMs: 2,
      open: false,
      attrs: { params: [{ email: "a@b.c" }], rowCount: 1, preview: "[{}]" },
      error: null,
      origin: "at lib/auth.ts:83",
    },
  ],
  dbTimeMs: 2,
  dbCount: 1,
  stages: ["handler"],
  curl: "curl -i http://x/",
  sourceFile: null,
};
const logSample = {
  id: 7,
  ts: NOW,
  level: "warn",
  message: "payment retry",
  attrs: { attempt: 2 },
  traceId: "t1",
  requestId: "r1",
  route: "/pay",
  source: "app",
};

const apiPayload = (url: string): unknown => {
  // A trace that rotated out of the live ring (and was never persisted):
  // both the live and the history detail endpoints 404, and the detail view
  // must fall through to its "not found" panel instead of crashing. Checked
  // first — the generic `/api/requests/` pattern below would otherwise catch
  // the live detail URL. Same for a rotated-out log record.
  if (
    url.includes("/api/requests/expired-1") ||
    url.includes("/api/history/expired-1") ||
    url.includes("/api/logs/999999")
  ) {
    return {
      ok: false,
      status: 404,
      json: () => Promise.reject(new Error("not found")),
      text: () => Promise.resolve(""),
    };
  }
  if (url.includes("/api/meta")) {
    return {
      serviceName: "t",
      version: "0",
      environment: "dev",
      nativeAvailable: false,
      bufferSize: 10,
      features: { history: true },
    };
  }
  if (url.includes("/api/requests/")) return traceSample;
  if (url.includes("/api/requests")) return [traceSample];
  if (url.includes("/api/logs/")) return logSample;
  if (url.includes("/api/logs"))
    return {
      enabled: true,
      persisted: false,
      records: [logSample],
      stats: { total: 1, debug: 0, info: 0, warn: 1, error: 0 },
    };
  if (url.includes("/api/history")) return { enabled: true, rows: [] };
  if (url.includes("/api/metrics/prometheus")) return "text";
  if (url.includes("/api/metrics"))
    return {
      startedAt: NOW,
      uptimeSec: 1,
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
      durationBucketsMs: [10],
    };
  if (url.includes("/api/diagnostics/gc"))
    return { ok: true, supported: true, freedMiB: 0, beforeHeapUsedMiB: 1, afterHeapUsedMiB: 1 };
  if (url.includes("/api/diagnostics"))
    return {
      verdict: "ok",
      checkedAt: NOW,
      windowMin: 1,
      samplesAnalyzed: 0,
      findings: [],
      trend: {
        heapMiBPerMin: 0,
        heapR2: 0,
        heapNowMiB: 1,
        heapMinMiB: 1,
        heapMaxMiB: 1,
        rssMiBPerMin: 0,
        eventLoopP95Ms: 0,
        activeRequestsMax: 0,
      },
      persist: { enabled: false },
    };
  if (url.includes("/api/state"))
    return {
      service: "t",
      version: "0",
      environment: "dev",
      debugMode: true,
      runtime: {
        bunVersion: "1",
        platform: "linux",
        arch: "x64",
        pid: 1,
        nodeEnv: "dev",
        startedAt: NOW,
        uptimeSec: 1,
      },
      memory: { rssMiB: 1, heapUsedMiB: 1, heapTotalMiB: 2, externalMiB: 0, arrayBuffersMiB: 0 },
      envKeys: [],
      routes: 0,
      plugins: [],
      stores: { tracesRetained: 0, logsRetained: 0, activeRequests: 0 },
      features: { logs: true, metrics: true, persist: false },
    };
  if (url.includes("/api/system"))
    return {
      sampling: true,
      sampleMs: 1000,
      samples: [],
      startedAt: NOW,
      uptimeSec: 1,
      totals: { requests: 0, errors: 0, avgDurationMs: 0, p95DurationMs: 0 },
    };
  // Enabled payloads with one sample row each: the migrated `StatRow`,
  // `DataTable` and composer bodies (`JobsView`, `EventsView`, `ClientsView`)
  // only execute on the enabled branch, so the smoke must serve one.
  if (url.includes("/api/jobs"))
    return {
      enabled: true,
      total: 2,
      byStatus: { queued: 1, running: 0, completed: 1, failed: 0 },
      recent: [{ name: "nightly-report", status: "completed", runAt: NOW }],
    };
  if (url.includes("/api/routes")) return { enabled: false };
  if (url.includes("/api/events"))
    return {
      enabled: true,
      sources: {
        nats: {
          present: true,
          label: "NATS bus",
          connected: true,
          status: "connected",
          size: 1,
          total: 1,
          in: 0,
          out: 1,
          errors: 0,
          bytes: 42,
          byName: { "orders.created": 1 },
        },
        nova: {
          present: true,
          label: "Nova realtime (WS)",
          size: 0,
          total: 2,
          in: 1,
          out: 1,
          errors: 0,
          bytes: 128,
          byName: {},
          captures: true,
        },
      },
      recent: [
        {
          id: "ev-1",
          ts: NOW,
          source: "nats",
          direction: "out",
          kind: "publish",
          name: "orders.created",
          payload: '{"orderId":"ord_1"}',
          size: 42,
          error: null,
        },
      ],
    };
  if (url.includes("/api/nova/events")) return { enabled: false };
  if (url.includes("/api/clients"))
    return {
      enabled: true,
      count: 1,
      gitError: null,
      clients: [
        {
          kind: "sdk",
          platform: "typescript",
          name: "@acme/sdk",
          version: "1.2.3",
          location: "/repo/packages/sdk",
          files: ["dist/index.js"],
          gitTags: ["v1.2.3"],
          latestTag: "v1.2.3",
          published: "tagged",
        },
      ],
    };
  if (url.includes("/api/ai/summary"))
    return {
      service: "t",
      version: "0",
      environment: "dev",
      uptimeSec: 1,
      traces: {
        total: 0,
        errors: 0,
        avgDurationMs: 0,
        p95DurationMs: 0,
        recentErrors: [],
        slowest: [],
      },
      events: { enabled: false, connected: false, total: 0, errors: 0, bySubject: {} },
      clients: [],
      observatory: {
        verdict: "ok",
        findings: [],
        heapMiBPerMin: 0,
        logErrors: 0,
        recentWarnings: [],
        persist: { enabled: false, path: null },
      },
      routes: 0,
    };
  if (url.includes("/api/kt")) return "# Knowledge";
  if (url.includes("/api/docs")) {
    const path = new URL(url, "http://x").searchParams.get("path");
    return path === null
      ? { docs: [{ path: "docs/a.md", title: "Alpha" }] }
      : {
          path,
          title: "Alpha",
          markdown: "# Alpha\n",
          html: "<h1>Alpha</h1>",
        };
  }
  if (url.includes("/api/stream/ticket")) return { ticket: "tkn-1" };
  return {};
};

const fetchStub = (input: RequestInfo | URL): Promise<unknown> => {
  const payload = apiPayload(String(input));
  // Response-shaped payloads (e.g. the 404 for rotated-out traces) pass
  // through as-is so `getJson`'s `res.ok` check rejects properly.
  if (typeof payload === "object" && payload !== null && "ok" in payload) {
    return Promise.resolve(payload);
  }
  return Promise.resolve({
    ok: true,
    json: () => Promise.resolve(payload),
    text: () => Promise.resolve(""),
  });
};

/** EventSource stub that never connects (exercises the polling fallback). */
class EventSourceStub {
  static readonly CONNECTING = 0;
  onopen: unknown = null;
  onerror: (() => void) | null = null;
  constructor(_url: string) {
    queueMicrotask((): void => this.onerror?.());
  }
  close(): void {}
}

/* ── the test ────────────────────────────────────────────────────────────── */

/** Every top-level view the shell can route to (all 15 registry entries). */
const VIEW_IDS = [
  "requests",
  "errors",
  "logs",
  "history",
  "metrics",
  "diagnostics",
  "system",
  "state",
  "jobs",
  "events",
  "routes",
  "clients",
  "ai",
  "kt",
  "docs",
] as const;

/** Characters the old chrome used as icons (spec §5 #15) — none may return. */
const EMOJI_CHROME = /[⚡◐⏸▶↻✕⚠✔✖🗄📄📚📈🗺📦⚙🧘🔌🔍🔗🗒]/u;

/**
 * Hash-mount every top-level view, flush its fetch chain, and report which
 * views rendered no `PageHeader` `<h1>`, which still showed emoji chrome, and
 * each view's body text (so sample-payload consumption can be asserted).
 */
const mountAllViews = async (): Promise<{
  headingless: string[];
  emojiViews: string[];
  bodyByView: Record<string, string>;
}> => {
  const headingless: string[] = [];
  const emojiViews: string[] = [];
  const bodyByView: Record<string, string> = {};
  for (const view of VIEW_IDS) {
    window.location.hash = `#/${view}`;
    window.dispatchEvent(new Event("hashchange"));
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const body = document.body.textContent ?? "";
    const h1 = document.querySelector("main h1");
    if (h1 === null || (h1.textContent ?? "").trim() === "") headingless.push(view);
    const emoji = EMOJI_CHROME.exec(body);
    if (emoji !== null) emojiViews.push(`${view} → ${emoji[0]}`);
    bodyByView[view] = body;
  }
  return { headingless, emojiViews, bodyByView };
};

describe("debugbar dashboard SPA bundle (executed)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.replaceChildren();
  });

  it("boots and renders every view without reference/runtime errors", async () => {
    // Timers are inert: the smoke test must not leave live handles behind
    // (the real timers are exercised in the browser). Invoking callbacks
    // immediately keeps the SSE retry/polling paths deterministic.
    vi.stubGlobal("fetch", fetchStub);
    vi.stubGlobal("EventSource", EventSourceStub);
    vi.stubGlobal("setInterval", (): number => 0);
    vi.stubGlobal("clearInterval", (): void => {});
    vi.stubGlobal("setTimeout", (fn: () => void): number => {
      fn();
      return 0;
    });
    vi.stubGlobal("clearTimeout", (): void => {});
    window.location.hash = "#/requests";

    expect(() => {
      // eslint-disable-next-line no-new-func
      new Function(DEBUGBAR_CLIENT_JS)();
    }).not.toThrow();

    // The shell mounted into body.
    expect(document.body.textContent ?? "").toContain("IgnEx Debugbar");

    // Every keyboard view shortcut fires its mount path; dispatch a
    // hashchange so the router observes each navigation.
    for (const key of ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]) {
      document.dispatchEvent(new KeyboardEvent("keydown", { key }));
      window.dispatchEvent(new Event("hashchange"));
    }
    await Promise.resolve();

    // The digit shortcuts only reach the first ten registry entries; `routes`,
    // `clients`, `ai`, `kt` and `docs` carry `key: ""` and are never mounted by
    // that loop. Mount all 15 top-level views by hash so every migrated body
    // executes, and assert each one owns a non-empty `PageHeader` `<h1>`
    // (spec §9a) and that no view re-introduced the old emoji/glyph chrome
    // (spec §5 #15).
    const { headingless, emojiViews, bodyByView } = await mountAllViews();
    expect(headingless).toEqual([]);
    expect(emojiViews).toEqual([]);

    // The enabled sample payloads are consumed by the migrated bodies, not
    // just the disabled/empty branches: the job, client and event rows render.
    expect(bodyByView.jobs ?? "").toContain("nightly-report");
    expect(bodyByView.clients ?? "").toContain("@acme/sdk");
    expect(bodyByView.events ?? "").toContain("orders.created");

    // Detail routes (deep links) still mount.
    window.location.hash = "#/requests/t1/waterfall";
    window.dispatchEvent(new Event("hashchange"));
    // The Queries tab renders sent/result payloads without overflow (the
    // wrap class must override the table's nowrap baseline).
    window.location.hash = "#/requests/t1/queries";
    window.dispatchEvent(new Event("hashchange"));
    window.location.hash = "#/logs/7";
    window.dispatchEvent(new Event("hashchange"));

    // Flush the promise chains (fetch → json → render).
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => queueMicrotask(resolve));

    // No view crashed with a reference error, and a detail record rendered.
    let allText = document.body.textContent ?? "";
    expect(allText).not.toContain("is not defined");
    expect(allText).not.toContain("overflow");
    expect(allText).not.toContain("ReferenceError");
    expect(allText).not.toContain("is not a function");
    expect(allText).toContain("payment retry");

    // The Docs panel mounts from deep links and renders a document.
    window.location.hash = "#/docs/docs%2Fa.md";
    window.dispatchEvent(new Event("hashchange"));
    for (let i = 0; i < 25; i++) await Promise.resolve();
    allText = document.body.textContent ?? "";
    expect(allText).not.toContain("is not defined");
    expect(allText).not.toContain("ReferenceError");
    expect(allText).not.toContain("is not a function");
    expect(allText).toContain("Alpha");

    // A rotated-out trace: live 404 → history 404 → the "not found" panel
    // renders instead of an uncaught rejection (deep links survive restarts
    // only while the ring still holds the trace).
    window.location.hash = "#/requests/expired-1";
    window.dispatchEvent(new Event("hashchange"));
    // The 404→404 fallback chain is several microtasks deep; flush them all.
    for (let i = 0; i < 25; i++) await Promise.resolve();

    allText = document.body.textContent ?? "";
    expect(allText).not.toContain("is not defined");
    expect(allText).not.toContain("ReferenceError");
    expect(allText).not.toContain("is not a function");
    // The expired trace shows the graceful not-found panel (404 surfaced).
    expect(allText).toContain("404");

    // A rotated-out log record: 404 → the log-detail not-found panel.
    window.location.hash = "#/logs/999999";
    window.dispatchEvent(new Event("hashchange"));
    for (let i = 0; i < 25; i++) await Promise.resolve();

    allText = document.body.textContent ?? "";
    expect(allText).not.toContain("is not defined");
    expect(allText).not.toContain("ReferenceError");
    expect(allText).not.toContain("is not a function");
    expect(allText).toContain("404");
    expect(allText).toContain("Live-ring records rotate out");
  });

  it("refetches on stream revisions and via the silent-stream watchdog", async () => {
    // EventSource stub that captures instances so a revision frame can be
    // delivered manually; the poll interval is captured for the watchdog.
    const sources: Array<{ handlers: Record<string, (ev: { data: string }) => void> }> = [];
    const intervals: Array<() => void> = [];
    const requestFetches: string[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL): Promise<unknown> => {
      const url = String(input);
      requestFetches.push(url);
      if (url.includes("/api/meta"))
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              serviceName: "t",
              version: "0",
              environment: "dev",
              nativeAvailable: false,
              features: {},
            }),
          text: () => Promise.resolve(""),
        });
      if (url.includes("/api/stream/ticket"))
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ticket: "t1" }),
          text: () => Promise.resolve(""),
        });
      return Promise.resolve({
        ok: true,
        json: () =>
          Promise.resolve(
            url.includes("/api/requests")
              ? [
                  {
                    id: "a1",
                    ts: Date.now(),
                    durationMs: 1,
                    method: "GET",
                    path: "/",
                    status: 200,
                    error: null,
                    dbTimeMs: 0,
                    dbCount: 0,
                    spanCount: 1,
                  },
                ]
              : [],
          ),
        text: () => Promise.resolve(""),
      });
    });
    vi.stubGlobal(
      "EventSource",
      class {
        static readonly CONNECTING = 0;
        onopen: unknown = null;
        onerror: (() => void) | null = null;
        handlers: Record<string, (ev: { data: string }) => void> = {};
        constructor() {
          sources.push(this);
        }
        addEventListener(type: string, fn: (ev: { data: string }) => void): void {
          this.handlers[type] = fn;
        }
        close(): void {}
      },
    );
    vi.stubGlobal("setInterval", (fn: () => void): number => {
      intervals.push(fn);
      return 1;
    });
    vi.stubGlobal("clearInterval", (): void => {});
    vi.stubGlobal("setTimeout", (): number => 0);
    vi.stubGlobal("clearTimeout", (): void => {});
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000_000);

    const requestsFetches = (): number =>
      requestFetches.filter((u) => u.includes("/api/requests") && !u.includes("/api/requests/"))
        .length;

    window.location.hash = "#/requests";
    new Function(DEBUGBAR_CLIENT_JS)();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(document.body.textContent ?? "").toContain("GET");
    const boot = requestsFetches();
    expect(boot).toBeGreaterThanOrEqual(1);

    // A stream revision (traces moved) triggers a domain refetch.
    sources[0]?.handlers.revision?.({
      data: JSON.stringify({ epoch: 1, traces: 5, logs: 0, metrics: 0, system: 0, events: 0 }),
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(requestsFetches()).toBeGreaterThan(boot);

    // Watchdog: while a revision is fresh, the poll stays quiet…
    const fresh = requestsFetches();
    intervals[0]?.();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(requestsFetches()).toBe(fresh);

    // …but once no frame has arrived for a full window, it bumps a full
    // refresh so a connected-but-silent stream cannot freeze the dashboard.
    nowSpy.mockReturnValue(1_000_000 + 6000);
    intervals[0]?.();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(requestsFetches()).toBeGreaterThan(fresh);
  });
});
