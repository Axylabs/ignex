/**
 * Unified lifecycle pipeline tests.
 *
 * `runLifecycle` is the shared request pipeline used by `createApp()` (and the
 * model for the compiler-generated server): pre-handler stages run in order,
 * the handler runs, post-handler stages transform the response, then
 * afterResponse observes it. Any stage may halt with a `Response`.
 */

import {
  buildPostStages,
  buildPreStages,
  createApp,
  createContext,
  EMPTY_LIFECYCLE,
  runLifecycle,
} from "@ignex/core";
import { describe, expect, it } from "vitest";

const req = () => new Request("http://localhost:3000/");

const lifecycle = (hooks: Partial<typeof EMPTY_LIFECYCLE>) => ({
  ...EMPTY_LIFECYCLE,
  ...hooks,
});

describe("runLifecycle", () => {
  it("runs pre stages in order, then handler, then post stages", async () => {
    const order: string[] = [];
    const lc = lifecycle({
      start: [async () => void order.push("start")],
      request: [async () => void order.push("request")],
      parse: [async () => void order.push("parse")],
      transform: [async () => void order.push("transform")],
      beforeHandle: [async () => void order.push("beforeHandle")],
      afterHandle: [async () => void order.push("afterHandle")],
      mapResponse: [async () => void order.push("mapResponse")],
      afterResponse: [async () => void order.push("afterResponse")],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => {
        order.push("handler");
        return new Response("ok");
      },
    );

    expect(order).toEqual([
      "start",
      "request",
      "parse",
      "transform",
      "beforeHandle",
      "handler",
      "afterHandle",
      "mapResponse",
      "afterResponse",
    ]);
    expect(await res.text()).toBe("ok");
  });

  it("halts immediately when a pre stage returns a Response", async () => {
    const lc = lifecycle({
      request: [async () => new Response("halt", { status: 401 })],
    });
    let handlerCalled = false;

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => {
        handlerCalled = true;
        return new Response("never");
      },
    );

    expect(res.status).toBe(401);
    expect(await res.text()).toBe("halt");
    expect(handlerCalled).toBe(false);
  });

  it("lets a post stage replace the response", async () => {
    const lc = lifecycle({
      mapResponse: [async (_c, res) => new Response(`mapped:${res.status}`, { status: 201 })],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => new Response("x", { status: 200 }),
    );

    expect(res.status).toBe(201);
    expect(await res.text()).toBe("mapped:200");
  });

  it("routes handler errors through the error stage", async () => {
    const lc = lifecycle({
      error: [async (_c, err) => new Response(`caught:${(err as Error).message}`, { status: 500 })],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => {
        throw new Error("boom");
      },
    );

    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught:boom");
  });

  it("does not re-run afterHandle when it throws on the success path", async () => {
    // The error came FROM the response pipeline; feeding it back through the
    // same pipeline would double a non-idempotent hook's side effects.
    let calls = 0;
    const lc = lifecycle({
      afterHandle: [
        () => {
          calls += 1;
          throw new Error("post boom");
        },
      ],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => new Response("ok"),
    );

    expect(res.status).toBe(500);
    expect(calls).toBe(1);
  });

  it("runs post stages on a halted (guard) response", async () => {
    const lc = lifecycle({
      beforeHandle: [() => new Response("halt", { status: 403 })],
      afterHandle: [
        (_ctx, res) => {
          res.headers.set("x-after", "1");
          return res;
        },
      ],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => new Response("never"),
    );

    expect(res.status).toBe(403);
    expect(await res.text()).toBe("halt");
    expect(res.headers.get("x-after")).toBe("1");
  });

  it("runs post stages and applies set mutations on error responses", async () => {
    // Plugins (CORS/compression) compose into afterHandle; they must decorate
    // error replies too, and `set` mutations from pre-handler hooks must still
    // be delivered (both were silently dropped by the old `return errorStage`).
    const lc = lifecycle({
      beforeHandle: [
        (ctx) => {
          ctx.set.headers["x-from-hook"] = "1";
          return { ok: true, ctx };
        },
      ],
      afterHandle: [
        (_ctx, res) => {
          res.headers.set("access-control-allow-origin", "*");
          return res;
        },
      ],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => {
        throw new Error("boom");
      },
    );

    expect(res.status).toBe(500);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("x-from-hook")).toBe("1");
  });

  it("does not let a throwing post stage mask the error response", async () => {
    const lc = lifecycle({
      afterHandle: [
        () => {
          throw new Error("post boom");
        },
      ],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => {
        throw new Error("handler boom");
      },
    );

    expect(res.status).toBe(500);
  });

  it("does not let afterResponse replace the response", async () => {
    const lc = lifecycle({
      afterResponse: [async () => new Response("ignored", { status: 418 })],
    });

    const res = await runLifecycle(
      lc,
      buildPreStages(lc),
      buildPostStages(lc),
      createContext(req(), {}),
      async () => new Response("final"),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("final");
  });

  it("composes pre/post stage chains in the documented order", () => {
    const lc = lifecycle({});
    expect(buildPreStages(lc)).toEqual([]);
    expect(buildPostStages(lc)).toEqual([]);

    const full = lifecycle({
      start: [async () => undefined],
      request: [async () => undefined],
      parse: [async () => undefined],
      transform: [async () => undefined],
      beforeHandle: [async () => undefined],
      afterHandle: [async () => undefined],
      mapResponse: [async () => undefined],
    });
    expect(buildPreStages(full)).toHaveLength(5);
    expect(buildPostStages(full)).toHaveLength(2);
  });
});

describe("createApp", () => {
  it("halts in a request hook before the handler", async () => {
    const app = createApp({
      lifecycle: { request: [async () => new Response("unauthorized", { status: 403 })] },
      handler: async () => new Response("ok"),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("unauthorized");
  });

  it("runs afterResponse observability hooks without altering the response", async () => {
    const seen: string[] = [];
    const app = createApp({
      lifecycle: { afterResponse: [async () => void seen.push("after")] },
      handler: async () => new Response("ok"),
    });

    const res = await app.handler(req());
    expect(await res.text()).toBe("ok");
    expect(seen).toEqual(["after"]);
  });

  it("applies mapResponse after afterHandle", async () => {
    const order: string[] = [];
    const app = createApp({
      lifecycle: {
        afterHandle: [
          async (_c, _response) => {
            order.push("afterHandle");
            // Pass-through hooks return undefined so the chain continues.
            return undefined;
          },
        ],
        mapResponse: [
          async (_c, response) => {
            order.push("mapResponse");
            return new Response(response.body, {
              status: 202,
              headers: { "x-mapped": "1" },
            });
          },
        ],
      },
      handler: async () => {
        order.push("handler");
        return new Response("ok");
      },
    });

    const res = await app.handler(req());
    expect(order).toEqual(["handler", "afterHandle", "mapResponse"]);
    expect(res.status).toBe(202);
    expect(res.headers.get("x-mapped")).toBe("1");
  });

  it("applies ctx.set headers/status/cookies to the final response", async () => {
    const app = createApp({
      handler: async (ctx) => {
        ctx.set.headers["x-custom"] = "yes";
        ctx.set.status = 201;
        ctx.set.cookie.sid = { value: "abc", httpOnly: true, path: "/" };
        return new Response("ok");
      },
    });

    const res = await app.handler(req());
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sid=abc");
    expect(cookie).toContain("HttpOnly");
  });

  it("does not clobber a non-200 Response when set.status is unset", async () => {
    const app = createApp({
      handler: async () => new Response("nope", { status: 401 }),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(401);
  });

  it("routes handler errors through the error stage with the mutated ctx", async () => {
    const seen: string[] = [];
    const app = createApp({
      lifecycle: {
        beforeHandle: [
          async (ctx) => {
            ctx.setState("user", "alice");
            return undefined;
          },
        ],
        error: [
          async (ctx, err) => {
            seen.push(ctx.getState("user") ?? "none", (err as Error).message);
            return undefined;
          },
        ],
      },
      handler: async () => {
        throw new Error("boom");
      },
    });

    const res = await app.handler(req());
    expect(seen).toEqual(["alice", "boom"]);
    expect(res.status).toBe(500);
  });

  it("a throwing afterResponse hook does not corrupt a good response", async () => {
    const app = createApp({
      lifecycle: {
        afterResponse: [
          async () => {
            throw new Error("observer blew up");
          },
        ],
      },
      handler: async () => new Response("ok", { status: 200 }),
    });

    const res = await app.handler(req());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("runs plugin init on init() and close on stop()", async () => {
    const events: string[] = [];
    const app = createApp({
      plugins: [
        {
          name: "p",
          async init() {
            events.push("init");
          },
          async close() {
            events.push("close");
          },
        },
      ],
      handler: async () => new Response("ok"),
    });

    await app.init();
    await app.init(); // idempotent
    await app.stop();
    expect(events).toEqual(["init", "close"]);
  });
});
