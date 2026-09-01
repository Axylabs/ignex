/**
 * Wire-level Mongo instrumentation + DB capture surface:
 *
 * - `instrumentMongoClient` turns driver command-monitoring events into `db`
 *   spans with sent/reply previews and durations, nested under the logical
 *   op span when one is open.
 * - Nested `db` spans are excluded from dbCount/dbTimeMs aggregates.
 * - `debugQuery` records non-array (object) payloads — WHAT WAS SENT.
 * - `/api/logs/:id` serves a single full record for the log-detail view.
 */

import { describe, expect, it } from "vitest";
import {
  beginTrace,
  debugQuery,
  enterTraceContext,
  instrumentMongoClient,
  LogStore,
  setTracingEnabled,
} from "../src/debug/index.js";
import type { MonitorableMongoClient } from "../src/debug/mongo.js";
import { createApp } from "../src/index.js";
import { debugbar } from "../src/plugins/debugbar.js";

/* ── harness ──────────────────────────────────────────────────────────── */

/** Fake command monitor events, replayed manually by each test. */
class FakeMongoClient implements MonitorableMongoClient {
  monitorCommands = false;
  private listeners = new Map<string, Array<(ev: never) => void>>();

  on(event: string, listener: (ev: never) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  off(event: string, listener: (ev: never) => void): unknown {
    const list = this.listeners.get(event) ?? [];
    const idx = list.indexOf(listener);
    if (idx !== -1) list.splice(idx, 1);
    return this;
  }

  emit(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) (fn as (e: unknown) => void)(payload);
  }

  /** A started+succeeded round-trip in one shot. */
  succeed(
    requestId: number,
    commandName: string,
    command: Record<string, unknown>,
    reply: unknown,
    duration = 3.21,
  ): void {
    this.emit("commandStarted", { requestId, commandName, command, databaseName: "app" });
    this.emit("commandSucceeded", { requestId, commandName, duration, reply });
  }
}

interface TraceJson {
  dbCount: number;
  dbTimeMs: number;
  spans: Array<{
    id: number;
    parentId: number | null;
    name: string;
    kind: string;
    durationMs: number;
    attrs: Record<string, unknown> | null;
    error: string | null;
  }>;
}

/** Activate a synthetic trace on the ALS (same mechanism as the plugin). */
const withTrace = async (fn: () => Promise<void>): Promise<TraceJson> => {
  setTracingEnabled(true);
  try {
    const { createContext } = await import("../src/index.js");
    const ctx = createContext(new Request("http://localhost:3000/gigs"), {}, {});
    const trace = beginTrace(ctx, false);
    enterTraceContext(trace);
    await fn();
    return trace.toJSON() as TraceJson;
  } finally {
    setTracingEnabled(false);
  }
};

/* ── instrumentMongoClient ────────────────────────────────────────────── */

describe("instrumentMongoClient", () => {
  it("records a wire-level db span with sent/reply/ms inside an active trace", async () => {
    const client = new FakeMongoClient();
    const json = await withTrace(async () => {
      instrumentMongoClient(client);
      await client.succeed(
        1,
        "find",
        { find: "gigs", filter: { city: "LHR" }, limit: 10 },
        {
          cursor: { firstBatch: [{ _id: "a" }, { _id: "b" }] },
        },
      );
    });
    client.dispose?.();
    const wire = json.spans.find((s) => s.name === "find app.gigs");
    expect(wire).toBeDefined();
    expect(wire?.kind).toBe("db");
    expect(wire?.attrs?.op).toBe("find");
    expect(wire?.attrs?.ns).toBe("app.gigs");
    expect(String(wire?.attrs?.sent)).toContain('"city":"LHR"');
    expect(String(wire?.attrs?.reply)).toContain("firstBatch");
    expect(wire?.attrs?.ms).toBeCloseTo(3.21, 2);
    // No logical wrapper → the wire span IS counted.
    expect(json.dbCount).toBe(1);
  });

  it("nests under an open logical db span and keeps aggregates truthful", async () => {
    const client = new FakeMongoClient();
    const json = await withTrace(async () => {
      instrumentMongoClient(client);
      // The ORM pattern: one logical op span wrapping the driver work.
      await debugQuery(
        "gigs.find",
        { filter: { city: "LHR" }, sort: { createdAt: -1 } },
        async () =>
          client.succeed(7, "find", { find: "gigs", filter: { city: "LHR" } }, { cursor: {} }),
      );
    });
    const logical = json.spans.find((s) => s.name === "gigs.find");
    const wire = json.spans.find((s) => s.name === "find app.gigs");
    expect(logical).toBeDefined();
    expect(wire).toBeDefined();
    // Parenting: the wire span hangs off the logical op span.
    expect(wire?.parentId).toBe(logical?.id);
    // WHAT WAS SENT recorded on both layers (logical params + raw command).
    expect(logical?.attrs?.params).toEqual({ filter: { city: "LHR" }, sort: { createdAt: -1 } });
    expect(String(wire?.attrs?.sent)).toContain('"city":"LHR"');
    // Aggregates count only the outermost op — no double counting.
    expect(json.dbCount).toBe(1);
    expect(json.dbTimeMs).toBeLessThan(50);
  });

  it("marks failed commands as error spans", async () => {
    const client = new FakeMongoClient();
    const json = await withTrace(async () => {
      instrumentMongoClient(client);
      client.emit("commandStarted", {
        requestId: 9,
        commandName: "insert",
        command: { insert: "gigs", documents: [{ title: "x" }] },
        databaseName: "app",
      });
      client.emit("commandFailed", {
        requestId: 9,
        commandName: "insert",
        duration: 1,
        failure: { ok: 0, errmsg: "duplicate key" },
      });
    });
    const wire = json.spans.find((s) => s.name === "insert app.gigs");
    expect(wire?.error).toContain("duplicate key");
    expect(String(wire?.attrs?.sent)).toContain("documents");
  });

  it("ignores commands outside any active trace and survives dispose", async () => {
    const client = new FakeMongoClient();
    const handle = instrumentMongoClient(client);
    expect(client.monitorCommands).toBe(true);
    // Untraced context (heartbeat / production traffic): must not throw.
    client.succeed(100, "isMaster", { isMaster: 1 }, { ok: 1 });

    const json = await withTrace(async () => {
      handle.dispose();
      expect(client.monitorCommands).toBe(false);
      client.succeed(101, "find", { find: "gigs" }, {});
    });
    expect(json.spans.filter((s) => s.kind === "db")).toHaveLength(0);

    // Double instrumentation is a guarded no-op (no duplicate listeners).
    const again = instrumentMongoClient(client);
    expect(client.monitorCommands).toBe(true); // re-enabled by second call
    again.dispose();
  });
});

/* ── log store getById + /api/logs/:id ───────────────────────────────── */

const req = (path: string, init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

describe("log detail (getById + /api/logs/:id)", () => {
  it("resolves a retained record by id and misses rotated ones", () => {
    const store = new LogStore({ maxRecords: 2 });
    store.push({ level: "info", message: "one" });
    store.push({ level: "warn", message: "two" });
    store.push({ level: "info", message: "three" }); // evicts "one"
    expect(store.getById(1)).toBeUndefined();
    expect(store.getById(2)?.message).toBe("two");
    expect(store.getById(999)).toBeUndefined();
  });

  it("serves a single record end-to-end and 404s unknown ids", async () => {
    const app = createApp({
      plugins: [
        debugbar({
          enabled: true,
          path: "/__debugbar",
          persist: false,
        }),
      ],
      handler: async (ctx) => {
        ctx.debug.log("info", "detail me", { k: 1 });
        return ctx.json({ ok: true });
      },
    });
    await app.handler(req("/pay"));

    const logs = (await (await app.handler(req("/__debugbar/api/logs"))).json()) as {
      records: Array<{ id: number; message: string; attrs: unknown }>;
    };
    const target = logs.records.find((r) => r.message === "detail me");
    expect(target).toBeDefined();

    const detail = await app.handler(req(`/__debugbar/api/logs/${target?.id}`));
    expect(detail.status).toBe(200);
    const rec = (await detail.json()) as { message: string; attrs: Record<string, unknown> };
    expect(rec.message).toBe("detail me");
    expect(rec.attrs).toEqual({ k: 1 });

    const miss = await app.handler(req("/__debugbar/api/logs/424242"));
    expect(miss.status).toBe(404);
    const bad = await app.handler(req("/__debugbar/api/logs/not-a-number"));
    expect(bad.status).toBe(404);
  });
});
