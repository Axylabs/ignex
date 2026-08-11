/**
 * Depth tests for the cache module added by the `data/cache` split:
 * the `Cache-Control` parser and `HttpResponseCache`'s request `no-cache`
 * bypass + stale-while-revalidate background refresh.
 */
import { describe, expect, it } from "vitest";
import { HttpResponseCache, parseCacheControl } from "../src/index.js";

describe("parseCacheControl", () => {
  it("parses bare presence directives", () => {
    const d = parseCacheControl(
      "no-store, no-cache, must-revalidate, immutable, public, private, proxy-revalidate, no-transform, only-if-cached",
    );
    expect(d).toMatchObject({
      noStore: true,
      noCache: true,
      mustRevalidate: true,
      immutable: true,
      public: true,
      private: true,
      proxyRevalidate: true,
      noTransform: true,
      onlyIfCached: true,
    });
  });

  it("parses numeric directives", () => {
    const d = parseCacheControl(
      "max-age=60, s-maxage=120, stale-while-revalidate=30, stale-if-error=86400",
    );
    expect(d.maxAge).toBe(60);
    expect(d.sMaxAge).toBe(120);
    expect(d.staleWhileRevalidate).toBe(30);
    expect(d.staleIfError).toBe(86400);
  });

  it("is case-insensitive and trims whitespace", () => {
    const d = parseCacheControl("  Max-Age = 10 , NO-STORE  ");
    expect(d.maxAge).toBe(10);
    expect(d.noStore).toBe(true);
  });

  it("ignores unknown directives and malformed numbers", () => {
    const d = parseCacheControl("foo, max-age=abc, bar=1");
    expect(d.maxAge).toBeUndefined();
    expect(d.noStore).toBe(false);
  });

  it("round-trips the cacheControl builder output", () => {
    const d = parseCacheControl(
      "public, max-age=60, stale-while-revalidate=30, s-maxage=120, immutable",
    );
    expect(d).toMatchObject({
      public: true,
      maxAge: 60,
      staleWhileRevalidate: 30,
      sMaxAge: 120,
      immutable: true,
    });
  });
});

describe("HttpResponseCache depth", () => {
  const req = (url = "http://x/", init: RequestInit = {}) => new Request(url, init);

  it("bypasses the cache on request no-cache", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("x", { status: 200 });
    };
    const noCache = req("http://x/", { headers: { "cache-control": "no-cache" } });
    await cache.getOrSet(noCache, factory);
    await cache.getOrSet(noCache, factory);
    expect(calls).toBe(2);
  });

  it("serves a stale hit and refreshes in the background", async () => {
    const cache = new HttpResponseCache({ ttlMs: 20, staleTtlMs: 500 });
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response(`body-${calls}`, { status: 200 });
    };

    const first = await cache.getOrSet(req(), factory);
    expect(await first.text()).toBe("body-1");

    // Age past the freshness lifetime so the entry becomes stale.
    await new Promise((resolve) => setTimeout(resolve, 40));

    const staleHit = await cache.getOrSet(req(), factory);
    expect(await staleHit.text()).toBe("body-1"); // stale served immediately
    expect(calls).toBe(2); // background refresh fired

    // The background refresh completes asynchronously; a later read is fresh.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const fresh = await cache.getOrSet(req(), factory);
    expect(await fresh.text()).toBe("body-2");
  });

  it("single-flights the background refresh (no stampede)", async () => {
    const cache = new HttpResponseCache({ ttlMs: 20, staleTtlMs: 1000 });
    let calls = 0;
    const factory = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 30)); // keep refresh in-flight
      return new Response(`body-${calls}`, { status: 200 });
    };

    await cache.getOrSet(req(), factory);
    await new Promise((resolve) => setTimeout(resolve, 40)); // now stale

    await cache.getOrSet(req(), factory); // triggers the background refresh
    const second = await cache.getOrSet(req(), factory); // must NOT trigger another
    expect(calls).toBe(2); // initial + one background refresh
    expect(await second.text()).toBe("body-1"); // still serving the stale entry
  });
});
