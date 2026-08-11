/**
 * @fileoverview Compiled-server edge-case matrix.
 *
 * Error envelopes, concurrency (module-state counter, single-flight cache),
 * slow routes, and hostile inputs (huge query strings, malformed encoding).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE);
  client = createClient(srv.base);
});

afterAll(() => srv.close());

describe("edge-cases matrix (compiled server)", () => {
  it("returns 500 with a generic envelope for a thrown handler error", async () => {
    const res = await client.get("/boom");
    expect(res.status).toBe(500);

    const body = (await jsonBody(res)) as { code?: string; error?: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    // The real message must not leak when exposeErrors is off.
    expect(body.error).not.toContain("kaboom");
  });

  it("serves concurrent requests to a module counter with unique values", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, () => client.get("/count")));
    const counts = (await Promise.all(responses.map((r) => jsonBody(r)))) as { count: number }[];
    const values = counts.map((c) => c.count).sort((a, b) => a - b);

    expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it("deduplicates concurrent identical requests via the single-flight cache", async () => {
    const responses = await Promise.all(Array.from({ length: 10 }, () => client.get("/cache")));
    const hits = (await Promise.all(responses.map((r) => jsonBody(r)))) as { hits: number }[];

    expect(new Set(hits.map((h) => h.hits)).size).toBe(1);
    expect(hits[0]?.hits).toBe(1);
  });

  it("serves a slow route after its delay", async () => {
    const start = Date.now();
    const res = await client.get("/slow");

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ slow: true });
    expect(Date.now() - start).toBeGreaterThanOrEqual(200);
  });

  it("handles a reasonably large query string", async () => {
    const big = "x".repeat(5_000);
    const res = await client.get(`/search?a=${big}`);
    expect(res.status).toBe(200);
  });

  it("rejects an oversized request line with 431", async () => {
    // A ~100 KB URL exceeds the server's request-line budget → 431 (Request
    // Header Fields Too Large). Rejecting is the correct robust behaviour.
    const big = "x".repeat(100_000);
    const res = await client.get(`/search?a=${big}`);
    expect(res.status).toBe(431);
  });

  it("handles malformed percent-encoding without crashing", async () => {
    // `%zz` is an invalid escape — the server must not 500 on it.
    const res = await client.get("/search?%zz=1");
    expect([200, 400]).toContain(res.status);
  });

  it("returns 404 for an unknown top-level path", async () => {
    expect((await client.get("/")).status).toBe(404);
  });
});
