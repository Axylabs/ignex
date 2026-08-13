/**
 * @fileoverview Port of Elysia `test/lifecycle/*` — hook lifecycle semantics
 * on the interpreted `createApp().handler()` path.
 *
 * Covered: before/afterHandle short-circuit + ordering, transform/derive via
 * ctx mutation, mapResponse replacing the response, afterResponse observe-only
 * (a throwing hook must not corrupt the final response), request/parse hook
 * ordering, graceful shutdown via stop hooks, and promise-valued handlers.
 *
 * Note: the interpreted path has no router, so Elysia's `params`-driven
 * short-circuit scenarios are expressed here via ctx state instead; the
 * compiled-path equivalents live in the app E2E matrix / parity corpus.
 */

import { createApp, type IgnexPlugin } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const hook = (fn: (ctx: any, arg?: unknown) => unknown) => ({ fn });

const hookApp = (
  lifecycle: Parameters<typeof createApp>[0]["lifecycle"],
  handler: Parameters<typeof createApp>[0]["handler"] = (ctx) => ctx.text("ok"),
) => createApp({ lifecycle, handler });

describe("beforeHandle", () => {
  it("can short-circuit the route handler by returning a Response", async () => {
    const res = await inject(
      hookApp({
        beforeHandle: [hook(() => ctxFromHook("short-circuit", 401))],
      }),
      { url: "/" },
    );

    expect(res.status).toBe(401);
    await expect(res.text()).resolves.toBe("short-circuit");
  });

  it("runs hooks in registration order", async () => {
    const order: string[] = [];
    const app = hookApp({
      beforeHandle: [hook(() => void order.push("A")), hook(() => void order.push("B"))],
    });

    await inject(app, { url: "/" });
    expect(order).toEqual(["A", "B"]);
  });

  it("lets a later beforeHandle short-circuit before the handler", async () => {
    let handlerCalled = false;
    const app = createApp({
      lifecycle: {
        beforeHandle: [hook(() => undefined), hook(() => new Response("halt", { status: 401 }))],
      },
      handler: () => {
        handlerCalled = true;
        return new Response("never");
      },
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(401);
    expect(handlerCalled).toBe(false);
  });
});

describe("afterHandle / mapResponse", () => {
  it("afterHandle sees the handler response", async () => {
    const seen: number[] = [];
    const app = hookApp(
      {
        afterHandle: [
          hook((_ctx, res) => {
            seen.push((res as Response).status);
          }),
        ],
      },
      () => new Response("x", { status: 202 }),
    );

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(202);
    expect(seen).toEqual([202]);
  });

  it("mapResponse can replace the final response", async () => {
    const app = hookApp(
      {
        mapResponse: [hook(() => new Response("mapped", { status: 201 }))],
      },
      () => new Response("original", { status: 200 }),
    );

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(201);
    await expect(res.text()).resolves.toBe("mapped");
  });
});

describe("transform / derive (ctx mutation)", () => {
  it("transform can mutate ctx before the handler runs", async () => {
    const app = createApp({
      lifecycle: {
        transform: [
          hook((ctx) => {
            ctx.setState("greeting", "hi");
          }),
        ],
      },
      handler: (ctx) => ctx.json({ greeting: ctx.getState("greeting") }),
    });

    const res = await inject(app, { url: "/" });
    await expect(res.json()).resolves.toEqual({ greeting: "hi" });
  });

  it("a hook can swap the context via { ctx }", async () => {
    const app = createApp({
      lifecycle: {
        transform: [
          hook((ctx) => {
            const next = ctx as any;
            next.state?.set("via-ctx", "yes");
            return { ctx };
          }),
        ],
      },
      handler: (ctx) => ctx.json({ v: ctx.getState("via-ctx") }),
    });

    const res = await inject(app, { url: "/" });
    await expect(res.json()).resolves.toEqual({ v: "yes" });
  });
});

describe("afterResponse (observe-only)", () => {
  it("cannot replace the final response", async () => {
    const app = hookApp({
      afterResponse: [hook(() => new Response("ignored", { status: 418 }))],
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("ok");
  });

  it("a throwing afterResponse hook does not corrupt the finalized response", async () => {
    const app = hookApp({
      afterResponse: [
        hook(() => {
          throw new Error("observe boom");
        }),
      ],
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("ok");
  });
});

describe("request / parse ordering", () => {
  it("runs the full documented pre-handler stage order", async () => {
    const order: string[] = [];
    const app = hookApp({
      start: [hook(() => void order.push("start"))],
      request: [hook(() => void order.push("request"))],
      parse: [hook(() => void order.push("parse"))],
      transform: [hook(() => void order.push("transform"))],
      beforeHandle: [hook(() => void order.push("beforeHandle"))],
    });

    await inject(app, { url: "/" });
    expect(order).toEqual(["start", "request", "parse", "transform", "beforeHandle"]);
  });
});

describe("graceful shutdown", () => {
  it("runs stop hooks and onStop on stop()", async () => {
    const stopped: string[] = [];
    const app = createApp({
      lifecycle: { stop: [hook(() => void stopped.push("stop-hook"))] },
      onStop: () => void stopped.push("onStop"),
      handler: (ctx) => ctx.text("ok"),
    });

    await inject(app, { url: "/" });
    await app.stop();

    expect(stopped).toEqual(["stop-hook", "onStop"]);
  });

  it("runs every stop hook even when one throws", async () => {
    const stopped: string[] = [];
    const app = createApp({
      lifecycle: {
        stop: [
          hook(() => {
            throw new Error("stop boom");
          }),
          hook(() => void stopped.push("second")),
        ],
      },
      handler: (ctx) => ctx.text("ok"),
    });

    await inject(app, { url: "/" });
    await app.stop();

    expect(stopped).toEqual(["second"]);
  });
});

describe("promise-return values", () => {
  it("awaits an async handler before applying the response", async () => {
    const app = createApp({
      handler: async (ctx) => {
        await new Promise((r) => setTimeout(r, 5));
        return ctx.json({ done: true });
      },
    });

    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ done: true });
  });

  it("supports plugins contributing lifecycle hooks (onion ordering)", async () => {
    const order: string[] = [];
    const plugin: IgnexPlugin = {
      name: "order-plugin",
      onRequest(ctx) {
        order.push("plugin-onRequest");
        return ctx;
      },
    };
    const app = createApp({
      plugins: [plugin],
      lifecycle: {
        beforeHandle: [hook(() => void order.push("app-beforeHandle"))],
      },
      handler: (ctx) => ctx.text("ok"),
    });

    await app.init();
    await inject(app, { url: "/" });
    expect(order).toEqual(["plugin-onRequest", "app-beforeHandle"]);
  });
});

// Local helper — keeps short-circuit hooks concise.
function ctxFromHook(text: string, status = 200): Response {
  return new Response(text, { status, headers: { "content-type": "text/plain" } });
}
