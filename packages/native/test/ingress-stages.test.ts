/**
 * Tests for the native ingress pipeline stages reachable through
 * `@ignus/native` `createNativePipeline` — the Rust fixed-window rate-limit
 * stage and the CORS stage. These prove the (previously dormant) stages work
 * end-to-end through the ignus bridge:
 *
 * - rate limit: allow `limit` requests per window, then terminal 429 from Rust
 * - CORS: OPTIONS preflight is terminal 204 (allowed, echoed origin) / 403
 *   (denied), and non-OPTIONS requests stay non-terminal (OK path continues)
 *
 * Skipped when the Rust addon is absent (fallback behavior is a no-op).
 */

import { createNativePipeline, isNativeAvailable } from "@ignus/native";
import { describe, expect, it } from "vitest";

const available = isNativeAvailable();

describe("native ingress stages (createNativePipeline)", () => {
  it.skipIf(!available)("rate-limit stage allows `limit`, then terminal 429", async () => {
    const pipeline = await createNativePipeline({
      options: { rateLimit: { limit: 2, windowMs: 60_000 } },
    });
    expect(pipeline).not.toBeNull();
    if (!pipeline) return;

    const results: Array<{ terminal: boolean; status: number | undefined }> = [];
    for (let i = 0; i < 4; i++) {
      const req = new Request("http://x/api?a=1&b=2", {
        headers: { "x-forwarded-for": "10.0.0.1" },
      });
      const out = await pipeline.preprocess(req, "10.0.0.1");
      results.push({ terminal: out.terminal, status: out.response?.status });
    }

    // Requests 1–2 within budget → OK path continues; 3–4 → terminal 429.
    expect(results[0]).toEqual({ terminal: false, status: undefined });
    expect(results[1]).toEqual({ terminal: false, status: undefined });
    expect(results[2]?.status).toBe(429);
    expect(results[3]?.status).toBe(429);
  });

  it.skipIf(!available)(
    "CORS preflight: allowed origin → terminal 204 + echoed allow-origin",
    async () => {
      const pipeline = await createNativePipeline({
        options: { cors: { allowOrigin: ["https://app.example.com"] } },
      });
      expect(pipeline).not.toBeNull();
      if (!pipeline) return;

      const preflight = new Request("http://x/", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "GET",
        },
      });
      const out = await pipeline.preprocess(preflight, "10.0.0.1");
      expect(out.terminal).toBe(true);
      expect(out.response?.status).toBe(204);
      expect(out.response?.headers.get("access-control-allow-origin")).toBe(
        "https://app.example.com",
      );
    },
  );

  it.skipIf(!available)("CORS preflight: denied origin → terminal 403", async () => {
    const pipeline = await createNativePipeline({
      options: { cors: { allowOrigin: ["https://app.example.com"] } },
    });
    if (!pipeline) return;

    const preflight = new Request("http://x/", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com", "access-control-request-method": "GET" },
    });
    const out = await pipeline.preprocess(preflight, "10.0.0.1");
    expect(out.terminal).toBe(true);
    expect(out.response?.status).toBe(403);
  });

  it.skipIf(!available)("OK path (non-OPTIONS) stays non-terminal", async () => {
    const pipeline = await createNativePipeline({
      options: { cors: { allowOrigin: ["https://app.example.com"] } },
    });
    if (!pipeline) return;

    const out = await pipeline.preprocess(new Request("http://x/hello"), "10.0.0.1");
    expect(out.terminal).toBe(false);
    expect(out.response).toBeNull();
  });
});
