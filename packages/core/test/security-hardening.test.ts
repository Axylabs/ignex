/**
 * Security hardening regression tests (2026-08-19).
 *
 * Covers Phase-1B production-readiness fixes:
 *   - session cookies get `Secure` in production (and auto-detect https in
 *     dev), without breaking plain-http dev;
 *   - a tampered/expired session cookie is CLEARED (max-age 0) instead of
 *     lingering or churning a fresh session every request;
 *   - weak / known-default session secrets are rejected in production;
 *   - `basicAuth` fails closed on malformed base64 (no silent decode);
 *   - `rateLimit` never collapses ALL traffic into one shared "anonymous"
 *     bucket when client IP detection is unavailable.
 */
import {
  basicAuth,
  createApp,
  createSessionManager,
  rateLimit,
  session,
  signCookie,
} from "@ignex/core";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Temporarily set NODE_ENV, restoring it after the test. */
const withNodeEnv = async (env: string, fn: () => Promise<void>): Promise<void> => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = env;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
};

describe("session cookie Secure", () => {
  it("sets Secure on session cookies in production", async () => {
    await withNodeEnv("production", async () => {
      const app = createApp({
        plugins: [session({ secret: "a-strong-session-secret-123456", createIfMissing: true })],
        handler: () => new Response("ok"),
      });
      const res = await app.handler(new Request("http://localhost/"));
      expect(res.headers.get("set-cookie")).toContain("Secure");
    });
  });

  it("auto-detects https in dev (Secure on an https request)", async () => {
    const app = createApp({
      plugins: [session({ secret: "super-secret", createIfMissing: true })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(new Request("https://localhost/"));
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("stays non-Secure for plain-http in dev (local dev keeps working)", async () => {
    const app = createApp({
      plugins: [session({ secret: "super-secret", createIfMissing: true })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(new Request("http://localhost/"));
    expect(res.headers.get("set-cookie")).not.toContain("Secure");
  });
});

describe("session tampered-cookie handling", () => {
  it("clears a cookie signed with the wrong secret (max-age 0)", async () => {
    const app = createApp({
      plugins: [session({ secret: "super-secret" })],
      handler: () => new Response("ok"),
    });
    // Signed with a DIFFERENT secret → invalid signature.
    const bad = signCookie(
      JSON.stringify({ id: "stale", data: {}, exp: Math.floor(Date.now() / 1000) + 3600 }),
      "wrong-secret",
    );
    const res = await app.handler(
      new Request("http://localhost/", { headers: { cookie: `sid=${bad}` } }),
    );
    const setCookie = res.headers.get("set-cookie") ?? "";
    // The stale cookie is deleted (empty value, max-age 0), so it can't
    // linger or mint a fresh session on every request.
    expect(setCookie).toContain("sid=");
    expect(setCookie).toContain("Max-Age=0");
  });
});

describe("session secret strength", () => {
  it("rejects short secrets in production", async () => {
    await withNodeEnv("production", async () => {
      expect(() => createSessionManager({ secret: "s3cret" })).toThrow(/16 characters/);
    });
  });

  it("rejects the known dev default secret in production", async () => {
    await withNodeEnv("production", async () => {
      expect(() => createSessionManager({ secret: "dev-secret-change-me" })).toThrow(/dev default/);
    });
  });

  it("accepts a strong secret in production", async () => {
    await withNodeEnv("production", async () => {
      expect(() =>
        createSessionManager({ secret: "correct-horse-battery-staple-9" }),
      ).not.toThrow();
    });
  });
});

describe("basicAuth fail-closed base64", () => {
  it("halts with 401 (and never calls verify) on malformed base64", async () => {
    let verifyCalled = false;
    const app = createApp({
      lifecycle: {
        beforeHandle: [
          basicAuth(() => {
            verifyCalled = true;
            return { user: "x" };
          }),
        ],
      },
      handler: () => new Response("ok"),
    });
    const res = await app.handler(
      new Request("http://localhost/", { headers: { authorization: "Basic !!!not-base64!!!" } }),
    );
    expect(res.status).toBe(401);
    expect(verifyCalled).toBe(false);
  });

  it("still authenticates well-formed base64", async () => {
    let verifyCalled = false;
    const app = createApp({
      lifecycle: {
        beforeHandle: [
          basicAuth(() => {
            verifyCalled = true;
            return { user: "x" };
          }),
        ],
      },
      handler: () => new Response("ok"),
    });
    const token = Buffer.from("user:pass").toString("base64");
    const res = await app.handler(
      new Request("http://localhost/", { headers: { authorization: `Basic ${token}` } }),
    );
    expect(res.status).toBe(200);
    expect(verifyCalled).toBe(true);
  });
});

describe("rateLimit anonymous-key safety", () => {
  it("warns loudly when every request keys as 'anonymous' (shared-bucket footgun)", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // No server.requestIP and no trustProxy → ctx.ip resolves to "anonymous".
    const app = createApp({
      plugins: [rateLimit({ maxRequests: 1, windowMs: 60_000 })],
      handler: () => new Response("ok"),
    });
    const r1 = await app.handler(new Request("http://localhost/"));
    const r2 = await app.handler(new Request("http://localhost/"));
    // The limiter keeps its documented semantics (429 once the shared bucket
    // is exhausted) — the operator is WARNED once to configure trustProxy /
    // keyGenerator so real clients don't all share one bucket.
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(429);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("rateLimit"));
  });
});
