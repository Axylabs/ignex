/** Cache availability and conservative response policy regressions. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpResponseCache } from "../src/data/cache/http-cache";
import type { CachedHttpResponse, HttpResponseCacheStore } from "../src/data/cache/types";

const request = () => new Request("http://cache.test/item");
afterEach(() => vi.restoreAllMocks());

describe("cache store error policy", () => {
  it.each([false, true])("returns origin on read/write errors (async: %s)", async (asyncStore) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const operation of ["get", "set"] as const) {
      const failure = () => {
        if (asyncStore) return Promise.reject(new Error("store unavailable"));
        throw new Error("store unavailable");
      };
      const store: HttpResponseCacheStore = {
        get: operation === "get" ? failure : () => undefined,
        set: operation === "set" ? failure : () => {},
      };
      const cache = new HttpResponseCache({ store });
      const factory = vi.fn(async () => new Response("origin"));
      expect(await (await cache.getOrSet(request(), factory)).text()).toBe("origin");
      expect(await (await cache.getOrSet(request(), factory)).text()).toBe("origin");
      expect(factory).toHaveBeenCalledTimes(2);
    }
    expect(warning).toHaveBeenCalledTimes(2);
  });

  it("retains strict store errors when requested", async () => {
    const error = new Error("store unavailable");
    const cache = new HttpResponseCache({
      onStoreError: "throw",
      store: {
        get: () => undefined,
        set: () => {
          throw error;
        },
      },
    });
    await expect(cache.getOrSet(request(), async () => new Response("ok"))).rejects.toBe(error);
  });

  it("does not swallow origin errors and clears the failed single-flight", async () => {
    const cache = new HttpResponseCache();
    const error = new Error("origin failed");
    await expect(
      cache.getOrSet(request(), async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(await (await cache.getOrSet(request(), async () => new Response("retry"))).text()).toBe(
      "retry",
    );
  });
});

describe("response cache policy", () => {
  it.each(["NO-STORE", "Private", "no-cache", "max-age=0", "s-maxage=0"])(
    "does not retain responses requiring bypass or revalidation (%s)",
    async (control) => {
      const cache = new HttpResponseCache();
      const req = request();
      await cache.set(
        cache.key(req),
        new Response("ok", { headers: { "cache-control": control } }),
      );
      expect(await cache.get(req, cache.key(req))).toBeNull();
    },
  );

  it("caps freshness and disables stale serving for must-revalidate", async () => {
    let stored: CachedHttpResponse | undefined;
    let lifetime: { ttlMs?: number; staleTtlMs?: number } | undefined;
    const cache = new HttpResponseCache({
      store: {
        get: () => stored,
        set: (_key, entry, options) => {
          stored = entry;
          lifetime = options;
        },
      },
    });
    await cache.set(
      "key",
      new Response("ok", {
        headers: { "cache-control": "max-age=10, s-maxage=2, must-revalidate" },
      }),
      { ttlMs: 9000, staleTtlMs: 5000 },
    );
    expect(stored?.ttlMs).toBe(2000);
    expect(lifetime).toEqual({ ttlMs: 2000, staleTtlMs: 0 });
  });

  it.each(["*", "accept-language"])("skips unrepresented Vary (%s)", async (vary) => {
    const cache = new HttpResponseCache();
    const factory = vi.fn(async () => new Response("ok", { headers: { vary } }));
    await cache.getOrSet(request(), factory);
    await cache.getOrSet(request(), factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("stores responses when configured variation covers Vary", async () => {
    const cache = new HttpResponseCache();
    const factory = vi.fn(async () => new Response("ok", { headers: { vary: "Accept-Language" } }));
    const options = { vary: ["accept-language"] };
    await cache.getOrSet(request(), factory, options);
    expect(await (await cache.getOrSet(request(), factory, options)).text()).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(1);
  });
});
