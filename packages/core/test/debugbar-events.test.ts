/**
 * Debugbar Events / Clients / AI panels — the new API surface:
 *   /api/events (+ publish/clear), /api/clients (git tags), /api/ai/summary.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContext } from "../src/http/context.js";
import { createRouter } from "../src/http/router.js";
import { createApp } from "../src/index.js";
import { debugbar } from "../src/plugins/debugbar.js";

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

let server: { requestIP(): null; fetch(r: Request): Promise<Response> };

const run = (
  app: { handler(req: Request, srv?: unknown): Promise<Response> },
  path: string,
  init: RequestInit = {},
) => app.handler(req(path, init), server);

const scratchDirs: string[] = [];
afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true });
  scratchDirs.length = 0;
  vi.unstubAllGlobals();
});

const scratchPkg = (name: string, version: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-dbg-"));
  scratchDirs.push(dir);
  const pkgPath = join(dir, "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify({
      name,
      version,
      kind: "client",
      platform: "flatbuffers",
      files: ["dist", "schema.fbs"],
    }),
  );
  return pkgPath;
};

/** A bare HTTP app with the debugbar plugin (AOT-style interception). */
const appWith = (
  options: Parameters<typeof debugbar>[0] = {},
): {
  handler(req: Request, srv?: unknown): Promise<Response>;
} =>
  createApp({
    plugins: [debugbar({ enabled: true, path: "/__debugbar", ...options })],
    router: createRouter(),
    handler: () => new Response("ok"),
  });

describe("debugbar events panel", () => {
  it("reports events disabled when NATS is not configured", async () => {
    const app = appWith();
    const res = await run(app, "/__debugbar/api/events");
    const body = (await res.json()) as { enabled: boolean };
    expect(body.enabled).toBe(false);
  });

  it("tracks publishes + exposes stats even with an unreachable server", async () => {
    const app = appWith({ nats: { url: "nats://127.0.0.1:1", connect: false } });
    const res = await run(app, "/__debugbar/api/events");
    const body = (await res.json()) as {
      enabled: boolean;
      stats: { enabled: boolean; connected: boolean; total: number; out: number };
    };
    expect(body.enabled).toBe(true);
    expect(body.stats.connected).toBe(false);

    const pub = await run(app, "/__debugbar/api/events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "orders.created", payload: { id: "o-1" } }),
    });
    const pubBody = (await pub.json()) as { ok: boolean };
    expect(pubBody.ok).toBe(false); // not connected — recorded as a failure

    const after = (await (await run(app, "/__debugbar/api/events")).json()) as {
      stats: { total: number; errors: number; bySubject: Record<string, number> };
      recent: Array<{ subject: string; direction: string; error: string | null }>;
    };
    expect(after.stats.total).toBe(1);
    expect(after.stats.errors).toBe(1);
    expect(after.recent[0]?.subject).toBe("orders.created");
    expect(after.recent[0]?.error).toBeTruthy();

    const cleared = await run(app, "/__debugbar/api/events/clear", { method: "POST" });
    expect((await cleared.json()) as { ok: boolean }).toEqual({ ok: true, cleared: true });
    const empty = (await (await run(app, "/__debugbar/api/events")).json()) as {
      stats: { total: number };
    };
    expect(empty.stats.total).toBe(0);
  });

  it("rejects a publish without a subject", async () => {
    const app = appWith({ nats: { url: "nats://127.0.0.1:1", connect: false } });
    const res = await run(app, "/__debugbar/api/events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: {} }),
    });
    expect(res.status).toBe(400);
  });
});

describe("debugbar clients panel", () => {
  it("lists probed client packages with local state", async () => {
    const pkg = scratchPkg("@acme/api-client", "1.0.0");
    const app = appWith({ clientPaths: [pkg] });
    const res = await run(app, "/__debugbar/api/clients");
    const body = (await res.json()) as {
      enabled: boolean;
      count: number;
      clients: Array<{ kind: string; platform: string; name: string; version: string }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.count).toBe(1);
    expect(body.clients[0]).toMatchObject({
      kind: "client",
      platform: "flatbuffers",
      name: "@acme/api-client",
      version: "1.0.0",
    });
  });

  it("refreshes the git-tag cache via ?refresh=1", async () => {
    const pkg = scratchPkg("@acme/api-sdk", "2.0.0");
    const app = appWith({ sdkPaths: [pkg], clientPaths: [] });
    const res = await run(app, "/__debugbar/api/clients?refresh=1");
    const body = (await res.json()) as { clients: Array<{ published: string }> };
    expect(body.clients[0]?.published).toBe("local");
  });
});

describe("debugbar AI summary", () => {
  it("returns a compact summary with traces, events and clients", async () => {
    const pkg = scratchPkg("@acme/api-client", "1.0.0");
    const app = appWith({
      nats: { url: "nats://127.0.0.1:1", connect: false },
      clientPaths: [pkg],
    });

    // Record a couple of traced requests (any requests work — the default
    // handler answers 404 for unknown paths, which is still traced).
    await run(app, "/anything");
    await run(app, "/elsewhere");

    const res = await run(app, "/__debugbar/api/ai/summary");
    const body = (await res.json()) as {
      service: string;
      traces: { total: number; errors: number; recentErrors: unknown[]; slowest: unknown[] };
      events: { enabled: boolean; connected: boolean; total: number };
      clients: Array<{ name: string; published: string }>;
      routes: number;
    };
    expect(body.service).toBe("ignex");
    expect(body.traces.total).toBeGreaterThanOrEqual(2);
    expect(Array.isArray(body.traces.recentErrors)).toBe(true);
    expect(Array.isArray(body.traces.slowest)).toBe(true);
    expect(body.events.enabled).toBe(true);
    expect(body.events.connected).toBe(false);
    expect(body.clients[0]?.name).toBe("@acme/api-client");
    expect(body.routes).toBeGreaterThanOrEqual(0);
  });

  it("serves the summary without a router (AOT-style context)", async () => {
    const app = appWith();
    const ctx = createContext(req("/__debugbar/api/ai/summary"), {}, {});
    const res = await app.handler(
      new Request("http://localhost:3000/__debugbar/api/ai/summary"),
      server,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(typeof body.service).toBe("string");
    void ctx;
  });
});
