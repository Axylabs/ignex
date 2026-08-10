/**
 * Plugin architecture tests — bridge ordering, plugin-context hooks, and
 * init/close wiring.
 */

import {
  createApp,
  createContext,
  createPluginContext,
  pluginContextToLifecycle,
} from "@flux/core";
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
    const fluxCtx = createContext(req(), {});
    ctx.addHook("beforeHandle", async () => ({ ok: true, ctx: fluxCtx }));

    const lc = pluginContextToLifecycle(ctx);
    expect(lc.beforeHandle).toHaveLength(1);
    expect(lc.request).toBeUndefined();
  });
});
