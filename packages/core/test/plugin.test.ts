/**
 * Plugin architecture tests — bridge ordering, plugin-context hooks, and
 * init/close wiring.
 */

import {
  createApp,
  createContext,
  createPluginContext,
  pluginContextToLifecycle,
} from "@ignex/core";
import { describe, expect, it } from "vitest";

const req = () => new Request("http://localhost:3000/");

describe("pluginsToLifeCycle", () => {
  it("runs plugin onResponse hooks in reverse (onion) order", async () => {
    const order: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "a",
          async onResponse() {
            order.push("a");
            // Pass-through hooks return undefined so the chain continues.
            return undefined;
          },
        },
        {
          name: "b",
          async onResponse() {
            order.push("b");
            return undefined;
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(200);
    // The last-registered plugin observes the response first (onion "way out").
    expect(order).toEqual(["b", "a"]);
  });

  it("runs plugin onRequest hooks in forward order", async () => {
    const order: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "a",
          async onRequest(ctx) {
            order.push("a");
            return ctx;
          },
        },
        {
          name: "b",
          async onRequest(ctx) {
            order.push("b");
            return ctx;
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    await app.handler(req());
    expect(order).toEqual(["a", "b"]);
  });

  it("lets a plugin onRequest halt with a Response", async () => {
    const app = createApp({
      plugins: [
        {
          name: "auth",
          async onRequest() {
            return new Response("denied", { status: 403 });
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("denied");
  });

  it("passes a real Error to onError hooks", async () => {
    let received: unknown;
    const app = createApp({
      plugins: [
        {
          name: "err",
          async onError(error) {
            received = error;
            return undefined;
          },
        },
      ],
      handler: async () => {
        throw new Error("boom");
      },
    });

    await app.handler(req());
    expect(received).toBeInstanceOf(Error);
    expect((received as Error).message).toBe("boom");
  });
});

describe("pluginContextToLifecycle", () => {
  it("converts hooks registered on the plugin context into lifecycle stages", () => {
    const ctx = createPluginContext();
    const ignexCtx = createContext(req(), {});
    ctx.addHook("beforeHandle", async () => ({ ok: true, ctx: ignexCtx }));

    const lc = pluginContextToLifecycle(ctx);
    expect(lc.beforeHandle).toHaveLength(1);
    expect(lc.request).toBeUndefined();
  });
});

describe("pattern-scoped global middleware", () => {
  it("scopes onRequest to matching pathnames (prefix wildcard)", async () => {
    const hits: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "admin-only",
          pattern: "/api/admin/*",
          onRequest(ctx) {
            hits.push(ctx.url.pathname);
            return ctx;
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(200);

    const outside = await app.handler(new Request("http://localhost:3000/api/public/x"));
    expect(outside.status).toBe(200);

    const inside = await app.handler(new Request("http://localhost:3000/api/admin/users"));
    expect(inside.status).toBe(200);

    // The base path itself matches a trailing-wildcard pattern too.
    const base = await app.handler(new Request("http://localhost:3000/api/admin"));
    expect(base.status).toBe(200);

    expect(hits).toEqual(["/api/admin/users", "/api/admin"]);
  });

  it("supports exact string, RegExp, and predicate patterns", async () => {
    const hits: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "exact",
          pattern: "/health",
          onRequest: (ctx) => {
            hits.push("exact");
            return ctx;
          },
        },
        {
          name: "re",
          pattern: /^\/api\//,
          onRequest: (ctx) => {
            hits.push("re");
            return ctx;
          },
        },
        {
          name: "pred",
          pattern: (pathname) => pathname.startsWith("/v2"),
          onRequest: (ctx) => {
            hits.push("pred");
            return ctx;
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    await app.handler(new Request("http://localhost:3000/health"));
    await app.handler(new Request("http://localhost:3000/api/things"));
    await app.handler(new Request("http://localhost:3000/v2/items"));
    await app.handler(new Request("http://localhost:3000/other"));

    expect(hits).toEqual(["exact", "re", "pred"]);
  });

  it("scopes onResponse by pattern too", async () => {
    const tags: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "version",
          pattern: "/api/*",
          async onResponse(_ctx, response) {
            const headers = new Headers(response.headers);
            headers.set("x-api-version", "1");
            tags.push("scoped");
            return new Response(response.body, { status: response.status, headers });
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    const api = await app.handler(new Request("http://localhost:3000/api/x"));
    expect(api.headers.get("x-api-version")).toBe("1");

    const other = await app.handler(new Request("http://localhost:3000/other"));
    expect(other.headers.get("x-api-version")).toBeNull();
    expect(tags).toEqual(["scoped"]);
  });
});
