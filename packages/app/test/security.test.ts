/**
 * @fileoverview Compiled-server security matrix.
 *
 * CORS (preflight + actual), security headers, rate limiting (429 + headers),
 * auth-gating, sessions, and compression (gzip threshold + Vary).
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

describe("security matrix (compiled server)", () => {
  it("answers a CORS preflight with the allowed origin", async () => {
    const res = await client.options("/static", { headers: { origin: "http://example.com" } });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
  });

  it("adds CORS headers to an actual request", async () => {
    const res = await client.get("/static", { headers: { origin: "http://example.com" } });
    expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
  });

  it("applies the security headers", async () => {
    const res = await client.get("/static");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // HSTS is deliberately HTTPS-only (never sent on plain HTTP).
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("rate limits /ratelimit after the configured budget (429 + headers)", async () => {
    const statuses: number[] = [];
    let limited: Response | null = null;

    for (let i = 0; i < 6; i++) {
      const res = await client.get("/ratelimit");
      statuses.push(res.status);
      if (res.status === 429) limited = res;
    }

    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses[5]).toBe(429);
    expect(limited?.headers.get("x-ratelimit-limit")).toBe("5");
    expect(limited?.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("protects the auth-gated route (401 without, 200 with token)", async () => {
    expect((await client.get("/secure")).status).toBe(401);

    const ok = await client.get("/secure", {
      headers: { authorization: "Bearer secret-token" },
    });
    expect(ok.status).toBe(200);
    expect(await jsonBody(ok)).toEqual({ secure: true });
  });

  it("sets and persists a session cookie", async () => {
    const first = await client.get("/session");
    expect(first.status).toBe(200);
    const setCookie = first.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sid=");

    const cookie = setCookie.split(";")[0] ?? "";
    const second = await client.get("/session", { headers: { cookie } });
    expect(second.status).toBe(200);
    const body = (await jsonBody(second)) as { visits?: number };
    expect(body.visits).toBeGreaterThan(1);
  });

  it("compresses a large JSON response with gzip", async () => {
    const res = await client.get("/large", { headers: { "accept-encoding": "gzip" } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
  });
});
