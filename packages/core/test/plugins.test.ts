/**
 * Middleware plugin edge cases — CORS, rate limiting, security headers,
 * compression, logging and sessions — exercised through `createApp`.
 */

import { isNativeAvailable } from "@ignex/native";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp, nativePreflight } from "../src/index.js";
import { createAppLogger } from "../src/plugins/app-logger.js";
import { compression } from "../src/plugins/compression.js";
import { cors } from "../src/plugins/cors.js";
import { createLogger, logger } from "../src/plugins/logger.js";
import { rateLimit } from "../src/plugins/ratelimit.js";
import { security } from "../src/plugins/security.js";
import { session } from "../src/plugins/session.js";
import { createMemorySessionStore } from "../src/security/session.js";

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

describe("cors", () => {
  it("answers preflight OPTIONS with 204 and echo headers", async () => {
    const app = createApp({
      plugins: [cors({ allowedHeaders: ["x-custom"] })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(
      req("/", {
        method: "OPTIONS",
        headers: { origin: "http://example.com" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://example.com");
    expect(res.headers.get("access-control-allow-methods")).toContain("GET");
    expect(res.headers.get("access-control-allow-headers")).toBe("x-custom");
    expect(res.headers.get("access-control-max-age")).toBe("86400");
  });

  it("rejects origin '*' combined with credentials", () => {
    expect(() => cors({ origin: "*", credentials: true })).toThrow(/credentials/);
  });

  it("echoes the request origin for a string allowlist", async () => {
    const app = createApp({
      plugins: [cors({ origin: "http://allowed.com", credentials: true })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/", { headers: { origin: "http://allowed.com" } }));
    expect(res.headers.get("access-control-allow-origin")).toBe("http://allowed.com");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("drops ACAO for a disallowed origin", async () => {
    const app = createApp({
      plugins: [cors({ origin: "http://allowed.com" })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/", { headers: { origin: "http://evil.com" } }));
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("appends Vary: Origin and exposes headers", async () => {
    const app = createApp({
      plugins: [cors({ exposedHeaders: ["x-total"] })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/", { headers: { origin: "http://a.com" } }));
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-expose-headers")).toBe("x-total");
  });

  it("returns the identical Response for a no-Origin request (zero re-wrap)", async () => {
    // The common no-Origin path must not copy headers or re-wrap the response —
    // it serves the exact same Response object back (perf-critical fast path).
    const plugin = cors() as unknown as {
      onResponse: (ctx: { headers: Headers }, response: Response) => Response;
    };
    const response = new Response("ok", { status: 200 });
    const out = plugin.onResponse({ headers: new Headers() }, response);
    expect(out).toBe(response);
  });
});

describe("rateLimit", () => {
  it("allows requests under the limit and returns rate-limit headers", async () => {
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 3 })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-ratelimit-limit")).toBe("3");
    expect(res.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(res.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);
  });

  it("returns 429 over the limit", async () => {
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1 })],
      handler: () => new Response("ok"),
    });
    expect((await app.handler(req("/"))).status).toBe(200);
    const blocked = await app.handler(req("/"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
  });

  it("supports an opt-in native backend (native: true, identical semantics)", async () => {
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1, native: true })],
      handler: () => new Response("ok"),
    });
    expect((await app.handler(req("/"))).status).toBe(200);
    const blocked = await app.handler(req("/"));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("x-ratelimit-limit")).toBe("1");
    expect(blocked.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(blocked.headers.get("x-ratelimit-reset")).toMatch(/^\d+$/);
    expect(await blocked.json()).toEqual({ error: "Too many requests" });
  });

  it("resets the window after it expires", async () => {
    vi.useFakeTimers();
    try {
      const app = createApp({
        plugins: [rateLimit({ windowMs: 1000, maxRequests: 1 })],
        handler: () => new Response("ok"),
      });

      const first = await app.handler(req("/"));
      expect(first.status).toBe(200);
      expect((await app.handler(req("/"))).status).toBe(429);

      vi.advanceTimersByTime(1500);
      expect((await app.handler(req("/"))).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses x-forwarded-for when trustProxy is set", async () => {
    const app = createApp({
      plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1, trustProxy: true })],
      handler: () => new Response("ok"),
    });
    const reqA = req("/", { headers: { "x-forwarded-for": "1.2.3.4" } });
    const reqB = req("/", { headers: { "x-forwarded-for": "5.6.7.8" } });
    expect((await app.handler(reqA)).status).toBe(200);
    expect((await app.handler(reqA)).status).toBe(429);
    expect((await app.handler(reqB)).status).toBe(200);
  });

  it("honors skip and custom key generators", async () => {
    const app = createApp({
      plugins: [
        rateLimit({
          windowMs: 60_000,
          maxRequests: 1,
          skip: (ctx) => ctx.path === "/skip",
          keyGenerator: () => "fixed-key",
        }),
      ],
      handler: () => new Response("ok"),
    });
    expect((await app.handler(req("/"))).status).toBe(200);
    expect((await app.handler(req("/"))).status).toBe(429);
    // /skip is exempt regardless of the shared key.
    expect((await app.handler(req("/skip"))).status).toBe(200);
  });
});

describe("security", () => {
  it("sets default security headers", async () => {
    const app = createApp({
      plugins: [security()],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/"));
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("adds HSTS only for https requests", async () => {
    const app = createApp({ plugins: [security()], handler: () => new Response("ok") });
    const http = await app.handler(req("/"));
    expect(http.headers.get("strict-transport-security")).toBeNull();

    // x-forwarded-proto is spoofable — ignored unless trustProxy is on.
    const forwarded = await app.handler(req("/", { headers: { "x-forwarded-proto": "https" } }));
    expect(forwarded.headers.get("strict-transport-security")).toBeNull();

    const proxied = createApp({
      plugins: [security({ trustProxy: true })],
      handler: () => new Response("ok"),
    });
    const https = await proxied.handler(req("/", { headers: { "x-forwarded-proto": "https" } }));
    expect(https.headers.get("strict-transport-security")).toContain("max-age=15552000");
    expect(https.headers.get("strict-transport-security")).toContain("includeSubDomains");
  });

  it("honors per-option disabling", async () => {
    const app = createApp({
      plugins: [security({ contentSecurityPolicy: false, hsts: false, frameguard: false })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/", { headers: { "x-forwarded-proto": "https" } }));
    expect(res.headers.get("content-security-policy")).toBeNull();
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-frame-options")).toBeNull();
  });

  it("does not overwrite an explicitly-set Content-Security-Policy", async () => {
    const app = createApp({
      plugins: [security()],
      handler: () =>
        new Response("ok", {
          headers: { "content-security-policy": "script-src 'self' https://cdn.example.com" },
        }),
    });
    const res = await app.handler(req("/"));
    // The docs page (e.g. `openapi()`) sets its own CSP to allow its CDN
    // bundles — the security plugin must respect it, not clobber it.
    expect(res.headers.get("content-security-policy")).toBe(
      "script-src 'self' https://cdn.example.com",
    );
    // Other baked headers are still applied.
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("removes X-Powered-By", async () => {
    const app = createApp({
      plugins: [security()],
      handler: () => new Response("ok", { headers: { "x-powered-by": "Bun" } }),
    });
    const res = await app.handler(req("/"));
    expect(res.headers.has("x-powered-by")).toBe(false);
  });
});

describe("compression", () => {
  it("compresses compressible bodies with gzip (round-trips)", async () => {
    const payload = JSON.stringify({ data: "x".repeat(2000) });
    const app = createApp({
      plugins: [compression()],
      handler: () =>
        new Response(payload, {
          headers: { "content-type": "application/json" },
        }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toContain("Accept-Encoding");
    // The (native) gzip output must decompress back to the original payload.
    const gz = await res.arrayBuffer();
    const text = await new Response(
      new Blob([gz]).stream().pipeThrough(new DecompressionStream("gzip")),
    ).text();
    expect(text).toBe(payload);
  });

  it("skips bodies below the threshold", async () => {
    const app = createApp({
      plugins: [compression({ threshold: 1024 })],
      handler: () =>
        new Response("short", {
          headers: { "content-type": "text/plain", "content-length": "5" },
        }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
  });

  it("skips non-compressible content types", async () => {
    const app = createApp({
      plugins: [compression()],
      handler: () =>
        new Response(new Uint8Array([1, 2, 3]).buffer, {
          headers: { "content-type": "image/png" },
        }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBeNull();
  });
});

describe("logger", () => {
  it("logs an info entry for a 200 response", async () => {
    const info = vi.fn();
    const app = createApp({
      plugins: [logger({ logger: { info, warn: vi.fn(), error: vi.fn() } as never })],
      handler: () => new Response("ok"),
    });
    await app.handler(req("/"));
    expect(info).toHaveBeenCalledOnce();
    const payload = (info.mock.calls[0] as unknown[])[0] as { status: number; method: string };
    expect(payload.status).toBe(200);
    expect(payload.method).toBe("GET");
  });

  it("honors the skip callback", async () => {
    const info = vi.fn();
    const app = createApp({
      plugins: [
        logger({ logger: { info, warn: vi.fn(), error: vi.fn() } as never, skip: () => true }),
      ],
      handler: () => new Response("ok"),
    });
    await app.handler(req("/"));
    expect(info).not.toHaveBeenCalled();
  });
});

describe("createLogger", () => {
  const origLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (origLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = origLogLevel;
  });

  it("defaults to info and honors the LOG_LEVEL env", () => {
    expect(createLogger().level).toBe("info");

    process.env.LOG_LEVEL = "debug";
    expect(createLogger().level).toBe("debug");
  });

  it("lets an explicit level win over the environment", () => {
    process.env.LOG_LEVEL = "debug";
    expect(createLogger({ level: "warn" }).level).toBe("warn");
    expect(createLogger({ level: "error" }).level).toBe("error");
  });
});

describe("createAppLogger", () => {
  it("merges plain objects and joins scalars in one variadic call", () => {
    const info = vi.fn();
    const log = createAppLogger({
      logger: {
        level: "info",
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      } as never,
    });
    log.info("order", 42, { orderId: 7 });
    expect(info).toHaveBeenCalledWith({ orderId: 7 }, "order 42");
  });

  it("renders a single object as structured fields", () => {
    const info = vi.fn();
    const log = createAppLogger({
      logger: {
        level: "info",
        debug: vi.fn(),
        info,
        warn: vi.fn(),
        error: vi.fn(),
        child: vi.fn(),
      } as never,
    });
    log.info({ orderId: 7, total: 12.5 });
    expect(info).toHaveBeenCalledWith({ orderId: 7, total: 12.5 }, "");
  });

  it("attaches errors under the err field next to the message", () => {
    const error = vi.fn();
    const log = createAppLogger({
      logger: {
        level: "info",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error,
        child: vi.fn(),
      } as never,
    });
    log.error(new Error("boom"), "failed");
    const [fields, msg] = error.mock.calls[0] as [Record<string, unknown>, string];
    expect((fields.err as { message: string }).message).toBe("boom");
    expect(msg).toBe("failed");
  });

  it("child() binds context onto a new leveled logger", () => {
    const child = vi.fn(() => ({
      level: "info",
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    }));
    const log = createAppLogger({
      logger: {
        level: "info",
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        child,
      } as never,
    });
    const scoped = log.child({ requestId: "abc" });
    scoped.info("hello");
    expect(child).toHaveBeenCalledWith({ requestId: "abc" });
  });

  it("setLevel() updates the current level", () => {
    let current = "info";
    const fake = {
      get level() {
        return current;
      },
      set level(v: string) {
        current = v;
      },
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(),
    };
    const log = createAppLogger({ logger: fake as never });
    log.setLevel("warn");
    expect(fake.level).toBe("warn");
    expect(log.level).toBe("warn");
  });

  it("pretty mode renders human-readable lines to stdout", () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      const log = createAppLogger({ pretty: true, color: false, level: "info" });
      log.info("order created", { orderId: 7 });
      const out = write.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("INFO");
      expect(out).toContain("order created");
      expect(out).toContain('"orderId": 7');
      expect(out).not.toContain('"level":30');
    } finally {
      write.mockRestore();
    }
  });
});

describe("nativePreflight", () => {
  it("is a no-op when disabled", async () => {
    const plugin = nativePreflight({ enabled: false });
    const ctx = { req: new Request("http://localhost/"), ip: "127.0.0.1" } as never;
    expect(await plugin.onRequest?.(ctx)).toBe(ctx);
  });

  it("is safe to mount without the Rust addon (handler still runs)", async () => {
    const app = createApp({
      plugins: [nativePreflight({ options: { rateLimit: { limit: 5, windowMs: 60_000 } } })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  // ── Native e2e (real addon). Without the addon these are no-ops; with it
  // they prove the Rust ingress pipeline short-circuits with terminal
  // responses (429 / 204 / 413) exactly as the docs promise. The bridge
  // options must actually reach the addon (nested under `{ options }`).

  it("native pipeline enforces rate limit → terminal 429", async () => {
    const app = createApp({
      plugins: [nativePreflight({ options: { rateLimit: { limit: 1, windowMs: 60_000 } } })],
      handler: () => new Response("ok"),
    });
    await app.init(); // eager path must not throw

    const first = await app.handler(req("/"));
    if (!isNativeAvailable()) {
      expect(first.status).toBe(200);
      return;
    }
    const second = await app.handler(req("/"));
    expect(second.status).toBe(429);
    expect(second.headers.get("ratelimit-limit")).toBe("1");
    expect(second.headers.get("ratelimit-remaining")).toBe("0");
    expect(second.headers.get("retry-after")).not.toBeNull();
  });

  it("native pipeline answers CORS preflight → terminal 204", async () => {
    const app = createApp({
      plugins: [nativePreflight({ options: { cors: { allowOrigin: ["*"] } } })],
      handler: () => new Response("ok"),
    });
    const preflight = await app.handler(
      req("/", {
        method: "OPTIONS",
        headers: { origin: "https://app.example.com", "access-control-request-method": "GET" },
      }),
    );
    if (isNativeAvailable()) {
      expect(preflight.status).toBe(204);
    } else {
      // No-op without the addon: falls through to the handler.
      expect([200, 204]).toContain(preflight.status);
    }
  });

  it("native pipeline guards oversize bodies → terminal 413", async () => {
    const app = createApp({
      plugins: [
        nativePreflight({
          // The pipeline owns the body in this mode so it can enforce the
          // size guard; the framework-safe default is readBody:false (the
          // app reads the body itself and enforces limits via http/body.ts).
          readBody: true,
          options: { maxBodyBytes: 1024, enableBodySizeGuard: true },
        }),
      ],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/", { method: "POST", body: "x".repeat(4096) }));
    if (isNativeAvailable()) {
      expect(res.status).toBe(413);
    } else {
      expect(res.status).toBe(200);
    }
  });

  it("skipWhenSafe (default): origin-less GETs pass through, CORS requests still served", async () => {
    // The fastest-path gate skips the Rust pipeline for requests that provably
    // cannot trigger a pipeline decision (no Origin, not a preflight, no rate
    // limit) — the handler must still run, and CORS-relevant requests (with an
    // Origin) must still reach the pipeline untouched.
    const app = createApp({
      plugins: [
        nativePreflight({ options: { cors: { allowOrigin: ["*"] } } }), // skipWhenSafe defaults on
      ],
      handler: () => new Response("ok"),
    });
    await app.init();

    const plain = await app.handler(req("/health")); // no Origin → gate skips
    expect(plain.status).toBe(200);
    expect(await plain.text()).toBe("ok");

    // A GET carrying an Origin must NOT be skipped (the pipeline's CORS
    // OK-path still evaluates it; the terminal decision is never a GET).
    const withOrigin = await app.handler(
      req("/api/users", { headers: { origin: "https://app.example.com" } }),
    );
    expect(withOrigin.status).toBe(200);

    // Explicit opt-out still runs the pipeline for everything (same outcome).
    const strict = createApp({
      plugins: [
        nativePreflight({
          options: { cors: { allowOrigin: ["*"] } },
          skipWhenSafe: false,
        }),
      ],
      handler: () => new Response("ok"),
    });
    await strict.init();
    expect((await strict.handler(req("/health"))).status).toBe(200);
  });
});

describe("session", () => {
  it("creates a signed session cookie when createIfMissing is set", async () => {
    const app = createApp({
      plugins: [session({ secret: "super-secret", createIfMissing: true })],
      handler: () => new Response("ok"),
    });
    const res = await app.handler(req("/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("sid=");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("releases the backing store on stop (closes sweep timer)", async () => {
    const store = createMemorySessionStore({ sweepIntervalMs: 1000 });
    const closeSpy = vi.spyOn(store, "close").mockImplementation(() => {});
    const app = createApp({
      plugins: [session({ secret: "s", store })],
      handler: () => new Response("ok"),
    });
    await app.stop();
    expect(closeSpy).toHaveBeenCalled();
    closeSpy.mockRestore();
  });
});
