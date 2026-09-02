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

const run = (
  app: { handler(req: Request, srv?: unknown): Promise<Response> },
  path: string,
  init: RequestInit = {},
) => app.handler(req(path, init));

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
  it("reports the buffer disabled when no source is wired (NATS or nova)", async () => {
    const app = appWith();
    const res = await run(app, "/__debugbar/api/events");
    const body = (await res.json()) as {
      enabled: boolean;
      hint?: string;
      sources: { nats: unknown; nova: unknown };
      recent: unknown[];
    };
    expect(body.enabled).toBe(false);
    expect(body.sources.nats).toBeNull();
    expect(body.sources.nova).toBeNull();
    expect(body.recent).toEqual([]);
    expect(body.hint).toContain("nova");
  });

  it("tracks NATS publishes + exposes stats even with an unreachable server", async () => {
    const app = appWith({ nats: { url: "nats://127.0.0.1:1", connect: false } });
    const res = await run(app, "/__debugbar/api/events");
    const body = (await res.json()) as {
      enabled: boolean;
      sources: {
        nats: {
          present: boolean;
          connected: boolean;
          size: number;
          out: number;
          errors: number;
        } | null;
        nova: unknown;
      };
    };
    expect(body.enabled).toBe(true);
    expect(body.sources.nova).toBeNull();
    expect(body.sources.nats?.present).toBe(true);
    expect(body.sources.nats?.connected).toBe(false);

    const pub = await run(app, "/__debugbar/api/events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "orders.created", payload: { id: "o-1" } }),
    });
    const pubBody = (await pub.json()) as { ok: boolean };
    expect(pubBody.ok).toBe(false); // not connected — recorded as a failure

    const after = (await (await run(app, "/__debugbar/api/events")).json()) as {
      sources: {
        nats: {
          size: number;
          out: number;
          errors: number;
          byName: Record<string, number>;
        } | null;
      };
      recent: Array<{
        source: string;
        direction: string;
        kind: string;
        name: string;
        error: string | null;
      }>;
    };
    expect(after.sources.nats?.size).toBe(1);
    expect(after.sources.nats?.out).toBe(1);
    expect(after.sources.nats?.errors).toBe(1);
    expect(after.sources.nats?.byName["orders.created"]).toBe(1);
    expect(after.recent[0]).toMatchObject({
      source: "nats",
      direction: "out",
      kind: "publish",
      name: "orders.created",
    });
    expect(after.recent[0]?.error).toBeTruthy();

    const cleared = await run(app, "/__debugbar/api/events/clear", { method: "POST" });
    expect((await cleared.json()) as { ok: boolean }).toEqual({ ok: true, cleared: true });
    const empty = (await (await run(app, "/__debugbar/api/events")).json()) as {
      sources: { nats: { size: number } | null };
    };
    expect(empty.sources.nats?.size).toBe(0);
  });

  it("merges the nova realtime trace into the unified buffer (sent + received)", async () => {
    let cleared = 0;
    const app = appWith({
      data: {
        nova: () => ({
          getEventTrace: () => ({
            enabled: true,
            capacity: 1024,
            stats: {
              size: 2,
              total: 2,
              inCount: 1,
              outCount: 1,
              bytes: 64,
              byName: { "quote.tick": 1, chat: 1 },
              last: { name: "quote.tick", ts: 1720000000000 },
            },
            recent: [
              {
                seq: 2,
                ts: 1720000000000,
                direction: "out.emit",
                name: "quote.tick",
                target: "user",
                key: "u-42",
                bytes: 32,
                payload: '{"price":1}',
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

    const res = await run(app, "/__debugbar/api/events");
    const body = (await res.json()) as {
      enabled: boolean;
      sources: {
        nats: unknown;
        nova: {
          present: boolean;
          size: number;
          in: number;
          out: number;
          byName: Record<string, number>;
          captures: boolean;
        } | null;
      };
      recent: Array<{
        source: string;
        direction: string;
        kind: string;
        name: string;
        key?: string;
        payload: string;
        size: number;
      }>;
    };
    expect(body.enabled).toBe(true);
    expect(body.sources.nats).toBeNull();
    expect(body.sources.nova).toMatchObject({
      present: true,
      size: 2,
      in: 1,
      out: 1,
      byName: { "quote.tick": 1, chat: 1 },
      captures: true,
    });
    expect(body.recent).toHaveLength(2);
    expect(body.recent).toContainEqual(
      expect.objectContaining({
        source: "nova",
        direction: "out",
        kind: "emit",
        name: "quote.tick",
        key: "u-42",
        payload: '{"price":1}',
      }),
    );
    expect(body.recent).toContainEqual(
      expect.objectContaining({
        source: "nova",
        direction: "in",
        kind: "client",
        name: "chat",
      }),
    );

    // clear drops both NATS rows (none here) and the nova trace ring
    const clearedRes = await run(app, "/__debugbar/api/events/clear", { method: "POST" });
    expect((await clearedRes.json()) as { ok: boolean }).toEqual({ ok: true, cleared: true });
    expect(cleared).toBe(1);
  });

  it("interleaves NATS + nova rows and filters by direction", async () => {
    const app = appWith({
      nats: { url: "nats://127.0.0.1:1", connect: false },
      data: {
        nova: () => ({
          getEventTrace: () => ({
            enabled: true,
            capacity: 8,
            stats: {
              size: 1,
              total: 1,
              inCount: 1,
              outCount: 0,
              bytes: 16,
              byName: { ping: 1 },
              last: { name: "ping", ts: Date.now() + 5000 },
            },
            recent: [
              {
                seq: 1,
                ts: Date.now() + 5000,
                direction: "in.client",
                name: "ping",
                bytes: 16,
              },
            ],
          }),
        }),
      },
    });
    // NATS publish fails (down) but still lands as an outbound row
    await run(app, "/__debugbar/api/events/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subject: "orders.created", payload: {} }),
    });

    const all = (await (await run(app, "/__debugbar/api/events")).json()) as {
      sources: { nats: { size: number } | null; nova: { size: number } | null };
      recent: Array<{ source: string; direction: string }>;
    };
    expect(all.sources.nats?.size).toBe(1);
    expect(all.sources.nova?.size).toBe(1);
    // newest first across sources (nova ts 1002 > nats now)
    expect(all.recent).toHaveLength(2);
    expect(all.recent[0]?.source).toBe("nova");

    const inbound = (await (await run(app, "/__debugbar/api/events?direction=in")).json()) as {
      recent: Array<{ source: string; direction: string }>;
    };
    expect(inbound.recent).toHaveLength(1);
    expect(inbound.recent[0]).toMatchObject({ source: "nova", direction: "in" });
  });

  it("fires a realtime event manually through the nova events hub", async () => {
    const emit = vi.fn();
    const emitToUser = vi.fn();
    const publish = vi.fn();
    const app = appWith({
      data: {
        nova: () => ({
          getEventTrace: () => ({
            enabled: false,
            capacity: 1,
            stats: { size: 0, total: 0, inCount: 0, outCount: 0, bytes: 0, byName: {} },
            recent: [],
          }),
          clearEventTrace: () => {},
          events: { emit, emitToUser },
          publish,
        }),
      },
    });
    const post = (path: string, body: unknown) =>
      run(app, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    // broadcast emit routes to the events hub
    const res = await post("/__debugbar/api/nova/events/emit", {
      name: "order.created",
      payload: { id: "o-1" },
    });
    const body = (await res.json()) as { ok: boolean; note?: string };
    expect(body.ok).toBe(true);
    expect(body.note).toContain("order.created");
    expect(emit).toHaveBeenCalledWith("order.created", { id: "o-1" });
    expect(emitToUser).not.toHaveBeenCalled();

    // a `type:key` target routes to the matching targeted emit
    const targeted = await post("/__debugbar/api/nova/events/emit", {
      name: "order.updated",
      payload: { id: "o-2" },
      target: "user:u-42",
    });
    expect(((await targeted.json()) as { ok: boolean }).ok).toBe(true);
    expect(emitToUser).toHaveBeenCalledWith("u-42", "order.updated", { id: "o-2" });
  });

  it("reports emit errors and rejects bad targets / a missing name", async () => {
    const emit = vi.fn(() => {
      throw new Error("unknown event 'ghost.thing'");
    });
    const app = appWith({
      data: {
        nova: () => ({
          getEventTrace: () => ({
            enabled: false,
            capacity: 1,
            stats: { size: 0, total: 0, inCount: 0, outCount: 0, bytes: 0, byName: {} },
            recent: [],
          }),
          clearEventTrace: () => {},
          events: { emit },
        }),
      },
    });
    const post = (path: string, body: unknown) =>
      run(app, path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    const boom = (await (
      await post("/__debugbar/api/nova/events/emit", { name: "ghost.thing" })
    ).json()) as {
      ok: boolean;
      error?: string;
    };
    expect(boom.ok).toBe(false);
    expect(boom.error).toContain("unknown event");

    const badTarget = await post("/__debugbar/api/nova/events/emit", {
      name: "order.created",
      target: "carrier:9",
    });
    expect(badTarget.status).toBe(400);

    const noName = await post("/__debugbar/api/nova/events/emit", { payload: {} });
    expect(noName.status).toBe(400);
  });

  it("falls back to the transport publish when no events hub is exposed", async () => {
    const publish = vi.fn();
    const app = appWith({
      data: {
        nova: () => ({
          getEventTrace: () => ({
            enabled: false,
            capacity: 1,
            stats: { size: 0, total: 0, inCount: 0, outCount: 0, bytes: 0, byName: {} },
            recent: [],
          }),
          clearEventTrace: () => {},
          publish,
        }),
      },
    });
    const res = await run(app, "/__debugbar/api/nova/events/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "order.created", payload: { id: "o-1" } }),
    });
    const body = (await res.json()) as { ok: boolean; note?: string };
    expect(body.ok).toBe(true);
    expect(body.note).toContain("transport");
    expect(publish).toHaveBeenCalledWith("order.created", { id: "o-1" });
  });

  it("rejects firing an event when nova is not wired", async () => {
    const app = appWith();
    const res = await run(app, "/__debugbar/api/nova/events/emit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "order.created", payload: {} }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("data.nova");
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
    const res = await app.handler(new Request("http://localhost:3000/__debugbar/api/ai/summary"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(typeof body.service).toBe("string");
    void ctx;
  });
});
