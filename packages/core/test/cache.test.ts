/**
 * HTTP caching primitives edge cases — cache-control builder, ETags, browser
 * conditional responses, the LRU response cache (single-flight) and the
 * generic LRUCache (eviction / stale / maxBytes).
 */

import { describe, expect, it, vi } from "vitest";
import type { CachedHttpResponse, HttpResponseCacheStore } from "../src/data/cache/types";
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

  it.each([false, true])("reads a fresh hit once (async store: %s)", async (asyncStore) => {
    const entries = new Map<string, CachedHttpResponse>();
    let reads = 0;
    let calls = 0;
    const store: HttpResponseCacheStore = {
      get(key) {
        reads++;
        const entry = entries.get(key);
        return asyncStore ? Promise.resolve(entry) : entry;
      },
      set(key, entry) {
        entries.set(key, entry);
      },
    };
    const cache = new HttpResponseCache({ store });
    const factory = async () => {
      calls++;
      return new Response("cached body");
    };
    await cache.getOrSet(req(), factory);
    reads = 0;

    const hit = await cache.getOrSet(req(), factory);
    expect(await hit.text()).toBe("cached body");
    expect(hit.headers.get("x-cache")).toBe("hit");
    expect(calls).toBe(1);
    expect(reads).toBe(1);

    reads = 0;
    const etag = hit.headers.get("etag");
    expect(etag).toBeTruthy();
    const conditional = await cache.getOrSet(
      req("http://x/", { headers: { "if-none-match": etag as string } }),
      factory,
    );
    expect(conditional.status).toBe(304);
    expect(await conditional.text()).toBe("");
    expect(reads).toBe(1);
    expect(calls).toBe(1);
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
    expect(await Promise.all(results.map((response) => response.text()))).toEqual([
      "body",
      "body",
      "body",
    ]);
  });

  it("single-flight gives every caller an independently consumable response", async () => {
    const cache = new HttpResponseCache();
    let calls = 0;
    const factory = async () => {
      calls += 1;
      return new Response("shared-origin", { status: 200 });
    };

    const results = await Promise.all([
      cache.getOrSet(req(), factory),
      cache.getOrSet(req(), factory),
      cache.getOrSet(req(), factory),
    ]);

    expect(calls).toBe(1);
    // Every caller must be able to read the body — not only the first one to
    // try. (Before independent responses, callers 2/3 shared the winner's
    // already-consumed Response and saw a disturbed/locked body.)
    expect(results.length).toBe(3);
    for (const [i, r] of results.entries()) {
      expect(r).toBeInstanceOf(Response);
      if (i > 0) expect(r).not.toBe(results[0]);
      expect(await (r as Response).text()).toBe("shared-origin");
    }
  });

  it.each(["cacheable", "non-cacheable", "oversized", "declined write"])(
    "single-flight preserves independent origin responses (%s)",
    async (mode) => {
      const cache = new HttpResponseCache({
        ...(mode === "oversized" ? { maxBodyBytes: 1 } : {}),
        ...(mode === "declined write" ? { maxBytes: 1 } : {}),
      });
      const factory = vi.fn(
        async () =>
          new Response("origin body", {
            status: 200,
            statusText: "Origin",
            headers: {
              "x-origin": "yes",
              ...(mode === "non-cacheable" ? { "cache-control": "no-store" } : {}),
            },
          }),
      );
      const responses: Response[] = [];
      const consume = async (response: Response) => {
        responses.push(response);
        expect(response.status).toBe(200);
        expect(response.statusText).toBe("Origin");
        expect(response.headers.get("x-origin")).toBe("yes");
        expect(response.headers.has("x-cache")).toBe(false);
        return response.text();
      };
      // Consume each response as soon as it arrives, not after all resolve.
      const bodies = await Promise.all([
        cache.getOrSet(req(), factory).then(consume),
        cache.getOrSet(req(), factory).then(consume),
        cache.getOrSet(req(), factory).then(consume),
      ]);
      expect(factory).toHaveBeenCalledTimes(1);
      expect(new Set(responses).size).toBe(3);
      expect(bodies).toEqual(["origin body", "origin body", "origin body"]);
      const hit = await cache.get(req(), cache.key(req()));
      if (mode === "cacheable") {
        expect(await hit?.text()).toBe("origin body");
      } else {
        expect(hit).toBeNull();
      }
    },
  );

  it.each([0, 4, 5])("enforces the cache body boundary (%i bytes)", async (size) => {
    const cache = new HttpResponseCache({ maxBodyBytes: 4 });
    const request = req();
    const payload = new Uint8Array(size).fill(7);
    const response = new Response(payload);
    expect(await cache.set(cache.key(request), response)).toBe(response);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
    const hit = await cache.get(request, cache.key(request));
    if (size > 4) {
      expect(hit).toBeNull();
    } else {
      expect(hit).not.toBeNull();
      if (!hit) throw new Error("Expected a cached response");
      expect(new Uint8Array(await hit.arrayBuffer())).toEqual(payload);
    }
  });

  it("stops an oversized cache fill without consuming the caller's response", async () => {
    const cache = new HttpResponseCache({ maxBodyBytes: 4 });
    let chunksRead = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          chunksRead += 1;
          controller.enqueue(new Uint8Array([1, 2, 3, 4]));
          if (chunksRead === 20) controller.close();
        },
      }),
    );
    const request = req();
    const returned = await cache.set(cache.key(request), response);

    expect(returned).toBe(response);
    // Allow stream prefetch, but never drain the oversized body for caching.
    expect(chunksRead).toBeLessThan(20);
    expect(response.bodyUsed).toBe(false);
    expect(await cache.get(request, cache.key(request))).toBeNull();
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      Uint8Array.from({ length: 80 }, (_, index) => (index % 4) + 1),
    );
  });

  it("fills a cold miss without re-reading the store", async () => {
    const backing = new Map<string, CachedHttpResponse>();
    const gets: string[] = [];
    const sets: string[] = [];
    const store: HttpResponseCacheStore = {
      get(key) {
        gets.push(key);
        return backing.get(key);
      },
      set(key, value) {
        sets.push(key);
        backing.set(key, value);
      },
    };
    const cache = new HttpResponseCache({ store });

    await cache.getOrSet(req(), async () => new Response("v", { status: 200 }));

    // The fill builds the entry itself — storing it must not require a
    // read-back (async stores would pay an extra sequential round-trip per
    // cold miss).
    expect(sets).toEqual(["GET:/:"]);
    expect(gets).toEqual(["GET:/:"]);
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
