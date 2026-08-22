/**
 * Debugger (MCP) tests — the AI-facing debugbar client. A tiny local HTTP
 * server serves debugbar-shaped fixtures so the tools are tested end-to-end
 * (URL resolution, token appending, error handling, payload shapes).
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  resolveDebugbarTarget,
  runDebugClientsTool,
  runDebugEventPublishTool,
  runDebugEventsTool,
  runDebugKtTool,
  runDebugReplayTool,
  runDebugRequestsTool,
  runDebugRequestTool,
  runDebugSummaryTool,
  runDebugSystemTool,
} from "../src/debugger.js";

let baseUrl: string;
let server: Server | undefined;

/** Request log so tests can assert what the client sent. */
const requests: Array<{ method: string; path: string; body: string }> = [];

const json = (data: unknown): string => JSON.stringify(data);

/** Fixture responses served by URL suffix (more specific paths first). */
const fixtures: Array<{ suffix: string; body: unknown }> = [
  {
    suffix: "/api/ai/summary",
    body: {
      service: "demo",
      traces: { total: 3, errors: 1, recentErrors: [], slowest: [] },
      events: { enabled: true },
      clients: [],
    },
  },
  { suffix: "/api/requests/r-1/replay", body: { ok: true, status: 200, durationMs: 5 } },
  {
    suffix: "/api/requests/r-1",
    body: { id: "r-1", spans: [], error: "boom", request: { url: "http://x/" } },
  },
  {
    suffix: "/api/requests",
    body: [{ id: "r-1", method: "GET", path: "/health", status: 500, error: "boom" }],
  },
  { suffix: "/api/events/publish", body: { ok: true, subject: "a.b" } },
  {
    suffix: "/api/events",
    body: {
      enabled: true,
      stats: { total: 2 },
      recent: [{ subject: "a.b", direction: "out", payload: "{}" }],
    },
  },
  { suffix: "/api/system", body: { sampling: true, samples: [] } },
  {
    suffix: "/api/clients",
    body: {
      count: 1,
      clients: [{ name: "@acme/api-client", version: "1.0.0", published: "local", gitTags: [] }],
    },
  },
  { suffix: "/api/kt", body: { markdown: "# demo — how this app works" } },
];

/** Match a pathname against the fixture table and write the response. */
const respond = (pathname: string, res: ServerResponse): void => {
  res.setHeader("content-type", "application/json");
  for (const fixture of fixtures) {
    if (pathname.endsWith(fixture.suffix)) {
      res.end(json(fixture.body));
      return;
    }
  }
  res.statusCode = 404;
  res.end(json({ error: "not_found" }));
};

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += String(d);
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, body });
      respond(url.pathname, res);
    });
  });
  await new Promise<void>((resolve) => {
    server?.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server?.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}/__debugbar`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
});

describe("resolveDebugbarTarget", () => {
  it("reads env defaults and normalizes the base URL", () => {
    const target = resolveDebugbarTarget("http://localhost:3000/__debugbar/", undefined);
    expect(target.baseUrl).toBe("http://localhost:3000/__debugbar");
    expect(target.token).toBeNull();
  });

  it("throws a descriptive error without a URL", () => {
    expect(() => resolveDebugbarTarget(undefined, undefined)).toThrow(/IGNEX_DEBUGBAR_URL/);
  });

  it("rejects non-http URLs", () => {
    expect(() => resolveDebugbarTarget("file:///tmp", undefined)).toThrow(/http/);
  });
});

describe("debugger tools", () => {
  it("summary tool returns the compact snapshot", async () => {
    const out = await runDebugSummaryTool({ url: baseUrl });
    const parsed = JSON.parse(out) as { service: string; traces: { errors: number } };
    expect(parsed.service).toBe("demo");
    expect(parsed.traces.errors).toBe(1);
  });

  it("requests tool applies filters via query params", async () => {
    await runDebugRequestsTool({ url: baseUrl, error: true, limit: 5, q: "health" });
    const call = requests.find((r) => r.path.startsWith("/__debugbar/api/requests"));
    expect(call?.path).toContain("error=1");
    expect(call?.path).toContain("limit=5");
    expect(call?.path).toContain("q=health");
  });

  it("request/replay/events/publish/system/clients/kt tools", async () => {
    const detail = JSON.parse(await runDebugRequestTool({ url: baseUrl, id: "r-1" })) as {
      id: string;
    };
    expect(detail.id).toBe("r-1");

    const replay = JSON.parse(await runDebugReplayTool({ url: baseUrl, id: "r-1" })) as {
      ok: boolean;
    };
    expect(replay.ok).toBe(true);

    const events = JSON.parse(await runDebugEventsTool({ url: baseUrl })) as {
      enabled: boolean;
      recent: Array<{ subject: string }>;
    };
    expect(events.enabled).toBe(true);
    expect(events.recent[0]?.subject).toBe("a.b");

    const pub = JSON.parse(
      await runDebugEventPublishTool({ url: baseUrl, subject: "a.b", payload: { x: 1 } }),
    ) as {
      ok: boolean;
    };
    expect(pub.ok).toBe(true);

    const sys = JSON.parse(await runDebugSystemTool({ url: baseUrl })) as { sampling: boolean };
    expect(sys.sampling).toBe(true);

    const clients = JSON.parse(await runDebugClientsTool({ url: baseUrl })) as {
      count: number;
    };
    expect(clients.count).toBe(1);

    const kt = await runDebugKtTool({ url: baseUrl });
    expect(kt).toContain("how this app works");
  });

  it("degrades to a structured error on failure", async () => {
    const out = await runDebugSummaryTool({ url: "http://127.0.0.1:1/__debugbar" });
    const parsed = JSON.parse(out) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBeTruthy();
  });

  it("requires a subject for publish", async () => {
    const out = JSON.parse(await runDebugEventPublishTool({ url: baseUrl, subject: " " })) as {
      ok: boolean;
    };
    expect(out.ok).toBe(false);
  });
});
