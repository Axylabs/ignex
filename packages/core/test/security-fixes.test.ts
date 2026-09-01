/**
 * Regression tests for the security-hardening pass:
 *  - rightmost-XFF rate-limit keying (leftmost is client-spoofable)
 *  - ctx.cache bypasses Authorization/cookie-bearing requests
 *  - compression excludes text/event-stream and streams unbounded bodies
 *  - session store-miss clears the dead cookie with matching path
 *  - Cookie.remove honors explicit deletion attributes (path parity)
 *  - runLifecycle applies `set` mutations on halts (compiled-pipeline parity)
 *  - security() ignores x-forwarded-proto unless trustProxy
 */

import { describe, expect, it, vi } from "vitest";
import { HttpResponseCache } from "../src/data/cache/http-cache.js";
import { isCompressible } from "../src/data/content-encoding.js";
import { createContext } from "../src/http/context.js";
import { createCookieJar } from "../src/http/cookies.js";
import { createApp } from "../src/lifecycle/lifecycle.js";
import { runLifecycle } from "../src/lifecycle/run.js";
import { lastForwardedIp } from "../src/platform/coerce.js";
import { compression } from "../src/plugins/compression.js";
import { rateLimit } from "../src/plugins/ratelimit.js";
import { security } from "../src/plugins/security.js";
import {
  createMemorySessionStore,
  createSessionManager,
  getSession,
} from "../src/security/session.js";

const req = (path = "/", init: RequestInit = {}) =>
  new Request(`http://localhost:3000${path}`, init);

describe("forwarded IP extraction", () => {
  it("lastForwardedIp returns the rightmost (proxy-appended) entry", () => {
    expect(lastForwardedIp("1.2.3.4, 5.6.7.8, 9.9.9.9")).toBe("9.9.9.9");
    expect(lastForwardedIp("1.2.3.4")).toBe("1.2.3.4");
    expect(lastForwardedIp(" , , ")).toBeUndefined();
    expect(lastForwardedIp(null)).toBeUndefined();
  });

  it("rate limiting keys on the LAST xff entry — rotating the leftmost cannot mint fresh buckets", async () => {
    vi.useFakeTimers();
    try {
      const app = createApp({
        plugins: [rateLimit({ windowMs: 60_000, maxRequests: 1, trustProxy: true })],
        handler: () => new Response("ok"),
      });
      // Attacker rotates a spoofed prefix; the trusted proxy's entry stays last.
      const spoofA = req("/", { headers: { "x-forwarded-for": "1.1.1.1, 10.0.0.1" } });
      const spoofB = req("/", { headers: { "x-forwarded-for": "2.2.2.2, 10.0.0.1" } });
      expect((await app.handler(spoofA)).status).toBe(200);
      expect((await app.handler(spoofB)).status).toBe(429);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("HttpResponseCache credential safety", () => {
  const factory = () => Promise.resolve(new Response("secret-body"));

  it("bypasses the cache for Authorization-bearing requests", async () => {
    const cache = new HttpResponseCache();
    const authed = req("/", { headers: { authorization: "Bearer tok" } });
    const first = await cache.getOrSet(authed, factory);
    expect(first.headers.get("x-cache")).toBeNull();
    const second = await cache.getOrSet(authed, factory);
    expect(second.headers.get("x-cache")).toBeNull();
  });

  it("bypasses cookie-bearing requests unless varying on cookie", async () => {
    const cache = new HttpResponseCache();
    const cookied = req("/", { headers: { cookie: "sid=abc" } });
    const miss = await cache.getOrSet(cookied, factory);
    expect(miss.headers.get("x-cache")).toBeNull();

    const vary = await cache.getOrSet(cookied, factory, { vary: ["cookie"] });
    expect(vary.headers.get("x-cache")).toBeNull();
    const hit = await cache.getOrSet(cookied, factory, { vary: ["cookie"] });
    expect(hit.headers.get("x-cache")).toBe("hit");
  });

  it("still caches anonymous requests", async () => {
    const cache = new HttpResponseCache();
    const anon = req("/");
    await cache.getOrSet(anon, factory);
    const hit = await cache.getOrSet(anon, factory);
    expect(hit.headers.get("x-cache")).toBe("hit");
  });
});

describe("compression hardening", () => {
  it("never compresses text/event-stream", () => {
    expect(isCompressible("text/event-stream")).toBe(false);
    expect(isCompressible("text/event-stream; charset=utf-8")).toBe(false);
    expect(isCompressible("text/plain")).toBe(true);
  });

  it("compresses an unknown-length stream incrementally (no full buffering)", async () => {
    let sent = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("y".repeat(4000)));
        sent = true;
        controller.close();
      },
    });
    const app = createApp({
      plugins: [compression()],
      handler: () => new Response(stream, { headers: { "content-type": "application/json" } }),
    });
    const res = await app.handler(req("/", { headers: { "accept-encoding": "gzip" } }));
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(sent).toBe(true);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
  });
});

describe("session cookie hygiene", () => {
  it("clears the cookie when the store row is gone (with path parity)", async () => {
    const store = createMemorySessionStore({ ttlSeconds: 60 });
    const manager = createSessionManager({ secret: "s3cret", store });

    const c = createContext(req("/"), {});
    const result = await manager.middleware({ createIfMissing: true })(c);
    expect(result.ok).toBe(true);
    const session = await getSession(c);
    if (!session) throw new Error("session missing");
    session.data.visits = 1;
    await session.save();
    const sid = c.cookie.sid?.value;
    expect(sid).toBeTruthy();

    // Simulate a server restart / evicted row without touching the client.
    await store.delete(session.id);

    const fresh = createContext(req("/", { headers: { cookie: `sid=${sid}` } }), {});
    await manager.middleware({})(fresh);
    const setCookie = fresh.set.cookie?.sid;
    expect(setCookie).toBeDefined();
    // Deletion cookie must match the write attributes.
    expect(String(setCookie?.maxAge ?? "")).toBe("0");
    expect(setCookie?.path).toBe("/");
  });
});

describe("Cookie.remove deletion attributes", () => {
  it("emits Path when given, so a Path=/ cookie is actually deleted", () => {
    const jar: Record<string, { value?: unknown; path?: string; maxAge?: number }> = {};
    const set: { cookie?: Record<string, (typeof jar)[string]> } = {};
    const cookies = createCookieJar(set as never, jar as never);
    cookies.sid?.remove({ path: "/" });
    const entry = set.cookie?.sid;
    expect(entry?.maxAge).toBe(0);
    expect(entry?.path).toBe("/");
  });
});

describe("runLifecycle halt-path applySet parity", () => {
  it("delivers set mutations written by a guard that then halts", async () => {
    const guard = (ctx: ReturnType<typeof createContext>) => {
      ctx.set.headers["x-bootstrap-cookie"] = "token=abc";
      return Response.json({ error: "forbidden" }, { status: 403 });
    };
    const c = createContext(req("/", { method: "POST" }), {});
    const response = await runLifecycle(
      {
        pre: [],
        post: [],
        beforeHandle: [],
        afterHandle: [],
        mapResponse: [],
        afterResponse: [],
        trace: [],
        error: [],
      } as never,
      [guard as never],
      [],
      c,
      () => new Response("ok"),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("x-bootstrap-cookie")).toBe("token=abc");
  });
});

describe("security plugin proxy trust", () => {
  it("ignores x-forwarded-proto by default and honors it under trustProxy", async () => {
    const strict = createApp({
      plugins: [security()],
      handler: () => new Response("ok"),
    });
    const spoofed = await strict.handler(req("/", { headers: { "x-forwarded-proto": "https" } }));
    expect(spoofed.headers.get("strict-transport-security")).toBeNull();

    const trusting = createApp({
      plugins: [security({ trustProxy: true })],
      handler: () => new Response("ok"),
    });
    const proxied = await trusting.handler(req("/", { headers: { "x-forwarded-proto": "https" } }));
    expect(proxied.headers.get("strict-transport-security")).toContain("max-age=");
  });
});
