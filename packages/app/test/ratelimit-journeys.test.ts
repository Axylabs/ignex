/**
 * @fileoverview Rate-limit journeys (compiled server).
 *
 * The fixture scopes a strict limiter (3 requests / 60s window, fixed-window,
 * keyed per IP) to `/ratelimit-strict` so this suite owns the whole bucket of
 * its freshly booted server process. The plugin's wire contract (see
 * `packages/core/src/plugins/ratelimit.ts`) is the `X-RateLimit-*` family:
 * `Limit`/`Remaining`/`Reset` (epoch seconds) on 200s via `onResponse`, and
 * the same headers on the 429 body `{ error: "Too many requests" }`. Retry
 * timing is carried by `X-RateLimit-Reset` — this limiter does not emit a
 * separate `Retry-After` header — so the journey asserts the reset instant
 * sits inside the configured window.
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

describe("rate-limit journeys (compiled server)", () => {
  it("allows the first 3 requests, then 429s with the X-RateLimit-* headers", async () => {
    const remaining: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await client.get("/ratelimit-strict");
      expect(res.status).toBe(200);
      expect(await jsonBody(res)).toEqual({ ok: true });

      // The budget is announced and decremented on every allowed request.
      expect(res.headers.get("x-ratelimit-limit")).toBe("3");
      expect(res.headers.get("x-ratelimit-remaining")).toBe(String(2 - i));
      const resetSec = Number(res.headers.get("x-ratelimit-reset"));
      // Reset is epoch seconds (ceil-rounded), inside the 60s window.
      expect(resetSec).toBeGreaterThan(Math.floor(Date.now() / 1000) - 1);
      expect(resetSec).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 61);
      remaining.push(Number(res.headers.get("x-ratelimit-remaining")));
    }
    expect(remaining).toEqual([2, 1, 0]);

    // 4th request inside the window → 429 with the plugin's error body.
    const limited = await client.get("/ratelimit-strict");
    expect(limited.status).toBe(429);
    expect(await jsonBody(limited)).toEqual({ error: "Too many requests" });

    // Headers on the rejection: budget exhausted, same reset contract.
    expect(limited.headers.get("x-ratelimit-limit")).toBe("3");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    const resetMs = Number(limited.headers.get("x-ratelimit-reset")) * 1000;
    expect(resetMs).toBeGreaterThan(Date.now() - 1_000);
    // Retry-after semantics: the reset instant is the earliest a retry can
    // succeed, and it must land within the configured 60s window (+1s of
    // ceil-rounding slack on the seconds-precision header).
    expect(resetMs).toBeLessThanOrEqual(Date.now() + 61_000);
  });

  it("keeps the limiter path-scoped (other routes are never throttled)", async () => {
    // The strict bucket for this IP is already exhausted by the journey above;
    // a different route must be untouched (the plugin `skip`s everything else).
    const health = await client.get("/health");
    expect(health.status).toBe(200);
    // No rate-limit headers leak onto skipped routes.
    expect(health.headers.get("x-ratelimit-limit")).toBeNull();
  });
});
