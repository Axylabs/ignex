/**
 * HTTP caching primitives edge cases — cache-control builder, ETags, browser
 * conditional responses, the LRU response cache (single-flight) and the
 * generic LRUCache (eviction / stale / maxBytes).
 */

import { describe, expect, it, vi } from "vitest";
import {
  cacheControl,
  entityTag,
  HttpResponseCache,
  LRUCache,
  withBrowserCache,
} from "../src/index.js";

describe("cacheControl", () => {
  it("prefers no-store over everything", () => {
    expect(cacheControl({ noStore: true, maxAge: 100, immutable: true })).toBe("no-store");
  });

  it("prefers no-cache over all other directives", () => {
    expect(cacheControl({ noCache: true, maxAge: 100 })).toBe("no-cache");
  });

  it("builds the full directive list", () => {
    expect(cacheControl({ public: true, maxAge: 60, swr: 30, sMaxAge: 120, immutable: true })).toBe(
      "public, max-age=60, stale-while-revalidate=30, s-maxage=120, immutable",
    );
  });

  it("clamps negative values to zero", () => {
    expect(cacheControl({ maxAge: -5, swr: -1 })).toBe("max-age=0, stale-while-revalidate=0");
  });

  it("returns no-cache when nothing meaningful is set", () => {
    expect(cacheControl()).toBe("no-cache");
  });
});

describe("entityTag", () => {
  it("produces weak tags by default and strong tags when requested", () => {
    expect(entityTag("abc")).toMatch(/^W\/"/);
    expect(entityTag("abc", false)).toMatch(/^"/);
  });

  it("is deterministic for the same input", () => {
    expect(entityTag("abc")).toBe(entityTag("abc"));
    expect(entityTag("abc")).not.toBe(entityTag("abd"));
  });
});

describe("withBrowserCache", () => {
  it("sets cache-control only when absent", () => {
    const res = withBrowserCache(new Response("x"), { maxAge: 60 });
    expect(res.headers.get("cache-control")).toBe("max-age=60");
  });

  it("keeps an existing cache-control header", () => {
    const res = withBrowserCache(new Response("x", { headers: { "cache-control": "no-store" } }), {
      maxAge: 60,
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("sets etag/last-modified/vary", () => {
    const res = withBrowserCache(new Response("x"), {
      etag: '"abc"',
      lastModified: new Date("2026-01-01T00:00:00Z"),
      vary: ["Origin", "Accept"],
    });
    expect(res.headers.get("etag")).toBe('"abc"');
    expect(res.headers.get("last-modified")).toContain("2026");
    expect(res.headers.get("vary")).toBe("Origin, Accept");
  });

  it("returns 304 when the request etag matches", () => {
    const req = new Request("http://x/", { headers: { "if-none-match": '"abc"' } });
    const res = withBrowserCache(new Response("x"), { etag: '"abc"', req });
    expect(res.status).toBe(304);
  });
});

describe("HttpResponseCache", () => {
  const req = (url = "http://x/", init: RequestInit = {}) => new Request(url, init);

  it("serves a cached response and marks it as a hit", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("body", { status: 200 });
    };

    const first = await cache.getOrSet(req(), factory);
    expect(calls).toBe(1);
    expect(first.headers.get("x-cache")).toBeNull();

    const second = await cache.getOrSet(req(), factory);
    expect(calls).toBe(1);
    expect(second.headers.get("x-cache")).toBe("hit");
    expect(await second.text()).toBe("body");
  });

  it("single-flights concurrent cold misses", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("body", { status: 200 });
    };

    const results = await Promise.all([
      cache.getOrSet(req(), factory),
      cache.getOrSet(req(), factory),
      cache.getOrSet(req(), factory),
    ]);

    expect(calls).toBe(1);
    // Single-flight shares the same Response instance across concurrent callers,
    // so only read the body once.
    expect(await (results[0] as Response).text()).toBe("body");
  });

  it("does not cache non-GET/HEAD methods", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("x", { status: 200 });
    };
    await cache.getOrSet(req("http://x/", { method: "POST" }), factory);
    await cache.getOrSet(req("http://x/", { method: "POST" }), factory);
    expect(calls).toBe(2);
  });

  it("honors request no-store", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("x", { status: 200 });
    };
    const noStore = req("http://x/", { headers: { "cache-control": "no-store" } });
    await cache.getOrSet(noStore, factory);
    await cache.getOrSet(noStore, factory);
    expect(calls).toBe(2);
  });

  it("skips responses with set-cookie or no-store", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("x", {
        status: 200,
        headers: { "set-cookie": "a=1" },
      });
    };
    await cache.getOrSet(req(), factory);
    await cache.getOrSet(req(), factory);
    expect(calls).toBe(2);
  });

  it("returns 304 for a cached etag match", async () => {
    const cache = new HttpResponseCache();
    const factory = async () => new Response("body", { status: 200 });
    await cache.getOrSet(req(), factory);

    const first = await cache.getOrSet(req(), factory);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const conditional = await cache.getOrSet(
      req("http://x/", { headers: { "if-none-match": etag as string } }),
      factory,
    );
    expect(conditional.status).toBe(304);
  });

  it("varies the cache key by the configured headers", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("x", { status: 200 });
    };
    await cache.getOrSet(req("http://x/", { headers: { "accept-language": "en" } }), factory, {
      vary: ["accept-language"],
    });
    await cache.getOrSet(req("http://x/", { headers: { "accept-language": "fr" } }), factory, {
      vary: ["accept-language"],
    });
    expect(calls).toBe(2);
  });
});

describe("LRUCache", () => {
  it("evicts by max entries", () => {
    const cache = new LRUCache<string, string>({ max: 2 });
    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
  });

  it("expires entries after ttl", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, string>({ ttlMs: 100 });
      cache.set("a", "1");
      expect(cache.get("a")).toBe("1");
      vi.advanceTimersByTime(150);
      expect(cache.get("a")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serves stale values when allowStale is set", () => {
    vi.useFakeTimers();
    try {
      const cache = new LRUCache<string, string>({ ttlMs: 100, staleTtlMs: 300 });
      cache.set("a", "1");
      vi.advanceTimersByTime(150);
      expect(cache.get("a")).toBeUndefined();
      expect(cache.get("a", { allowStale: true })).toBe("1");
      vi.advanceTimersByTime(200);
      expect(cache.get("a", { allowStale: true })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized entries when maxBytes is set", () => {
    const cache = new LRUCache<string, string>({ maxBytes: 10, sizeOf: (v) => v.length });
    cache.set("a", "12345");
    expect(cache.get("a")).toBe("12345");
    cache.set("b", "12345678901");
    expect(cache.get("b")).toBeUndefined();
  });

  it("single-flights getOrSet", async () => {
    const cache = new LRUCache<string, string>();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return "value";
    };
    const values = await Promise.all([cache.getOrSet("k", factory), cache.getOrSet("k", factory)]);
    expect(calls).toBe(1);
    expect(values).toEqual(["value", "value"]);
  });

  it("invokes onEvict when an entry is dropped", () => {
    const evicted: Array<[string, string]> = [];
    const cache = new LRUCache<string, string>({ max: 1, onEvict: (k, v) => evicted.push([k, v]) });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(evicted).toContainEqual(["a", "1"]);
  });
});
