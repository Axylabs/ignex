/**
 * Observatory persistence tests — the SQLite sink (bun:sqlite): batched
 * writes, retention, history queries and cross-restart reads.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ObservatoryDb } from "../src/debug/persist.js";
import type { RequestTrace } from "../src/debug/types.js";
import { loadBunSqlite } from "../src/platform/sqlite.js";

const trace = (id: string, over: Partial<RequestTrace> = {}): RequestTrace => ({
  id,
  ts: Date.now(),
  startedAtMs: 0,
  durationMs: 12,
  method: "GET",
  path: "/hi",
  route: "/hi",
  status: 200,
  requestId: `reqid-${id}`,
  ip: "127.0.0.1",
  error: null,
  errorStack: null,
  request: {
    method: "GET",
    url: `http://localhost/hi?id=${id}`,
    headers: { "x-a": "b" },
    body: null,
  },
  responseHeaders: { "content-type": "application/json" },
  responseBody: null,
  responseBodyTruncated: false,
  spans: [
    {
      id: 0,
      parentId: null,
      name: "GET /hi",
      kind: "request",
      startMs: 0,
      durationMs: 12,
      open: false,
      attrs: null,
      error: null,
      origin: null,
    },
    {
      id: 1,
      parentId: 0,
      name: "SELECT 1",
      kind: "db",
      startMs: 1,
      durationMs: 3,
      open: false,
      attrs: { params: [1] },
      error: null,
      origin: "db.ts",
    },
  ],
  dbTimeMs: 3,
  dbCount: 1,
  stages: ["request"],
  ...over,
});

const dirs: string[] = [];
const tempPath = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "ignex-obs-"));
  dirs.push(dir);
  return join(dir, "observatory.db");
};

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
  vi.restoreAllMocks();
});

describe("ObservatoryDb", () => {
  it("persists traces + spans + logs + samples and answers history queries", async () => {
    if (!(await loadBunSqlite())) return; // bun:sqlite unavailable
    const db = await ObservatoryDb.create({ path: tempPath(), flushIntervalMs: 5 });
    expect(db).not.toBeNull();
    if (!db) return;
    db.start();

    db.pushTrace(trace("t-1", { responseBody: '{"ok":true}', responseBodyTruncated: false }));
    db.pushTrace(trace("t-2", { status: 500, error: "kaboom", path: "/explode" }));
    db.pushLog({
      id: 1,
      ts: Date.now(),
      level: "warn",
      message: "cache stampede on /hot",
      attrs: { depth: 3 },
      traceId: "t-1",
      requestId: "reqid-t-1",
      route: "/hi",
      source: "app",
    });
    db.pushSample({
      ts: Date.now(),
      cpuPct: 12,
      rssMiB: 90,
      heapMiB: 55,
      eventLoopDelayMs: 1,
      activeRequests: 2,
    });
    await db.flush();

    const rows = db.queryTraces({});
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.id)).toContain("t-1");

    // Filters: errors-only, text, min duration, status family.
    expect(db.queryTraces({ errorsOnly: true }).map((r) => r.id)).toEqual(["t-2"]);
    expect(db.queryTraces({ q: "explode" }).length).toBe(1);
    expect(db.queryTraces({ minDurationMs: 100 }).length).toBe(0);
    expect(db.queryTraces({ status: "5xx" }).length).toBe(1);

    // Full reconstruction with spans.
    const full = db.getTrace("t-1");
    expect(full?.spans.length).toBe(2);
    expect(full?.spans.find((s) => s.name === "SELECT 1")?.kind).toBe("db");
    expect(full?.request.headers["x-a"]).toBe("b");
    expect(full?.responseBody).toBe('{"ok":true}');
    expect(full?.responseBodyTruncated).toBe(false);
    expect(db.getTrace("missing")).toBeUndefined();

    // Logs + samples round-trip.
    const logs = db.queryLogs({ minLevel: "warn" });
    expect(logs.length).toBe(1);
    expect(logs[0]?.message).toContain("stampede");
    expect(logs[0]?.attrs).toEqual({ depth: 3 });
    expect(db.querySamples()[0]?.rssMiB).toBe(90);

    const status = db.status();
    expect(status.available).toBe(true);
    expect(status.rows.traces).toBe(2);
    expect(status.rows.logs).toBe(1);
    await db.close();
  });

  it("history survives a restart (reopen from disk)", async () => {
    if (!(await loadBunSqlite())) return;
    const path = tempPath();
    const first = await ObservatoryDb.create({ path, flushIntervalMs: 5 });
    if (!first) return;
    first.start();
    first.pushTrace(trace("t-old", { ts: Date.now() - 60_000 }));
    await first.flush();
    await first.close();

    const second = await ObservatoryDb.create({ path, flushIntervalMs: 5 });
    if (!second) return;
    second.start();
    expect(second.queryTraces({}).map((r) => r.id)).toEqual(["t-old"]);
    await second.close();
  });

  it("prunes rows older than maxAgeSec", async () => {
    if (!(await loadBunSqlite())) return;
    const db = await ObservatoryDb.create({
      path: tempPath(),
      flushIntervalMs: 5,
      maxAgeSec: 1,
      pruneIntervalMs: 10,
    });
    if (!db) return;
    db.start();
    db.pushTrace(trace("t-ancient", { ts: Date.now() - 10_000 }));
    db.pushTrace(trace("t-fresh"));
    await db.flush(); // triggers pruneIfNeeded
    await new Promise<void>((r) => setTimeout(r, 30));
    await db.flush();
    const ids = db.queryTraces({}).map((r) => r.id);
    expect(ids).not.toContain("t-ancient");
    expect(ids).toContain("t-fresh");
    await db.close();
  });

  it("degrades to a no-op when bun:sqlite is unavailable", async () => {
    const db = await ObservatoryDb.create({
      path: ":memory:",
      loadSqlite: async () => null,
    });
    expect(db).not.toBeNull();
    db?.start();
    db?.pushTrace(trace("t-x"));
    db?.pushLog({
      id: 9,
      ts: Date.now(),
      level: "info",
      message: "m",
      attrs: null,
      traceId: null,
      requestId: null,
      route: null,
      source: "app",
    });
    await db?.flush();
    expect(db?.status().available).toBe(false);
    expect(db?.queryTraces({})).toEqual([]);
    expect(db?.queryLogs({})).toEqual([]);
    expect(db?.querySamples()).toEqual([]);
    await db?.close();
  });
});
