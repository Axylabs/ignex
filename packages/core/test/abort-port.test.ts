/**
 * @fileoverview Port of Elysia `test/core/abort.test.ts` +
 * `test/core/abort-race.test.ts` — AbortSignal handling on the interpreted
 * path.
 *
 * KNOWN DIVERGENCE (pinned behaviour, not a bug fix): Elysia short-circuits a
 * pre-aborted request (the route handler is never called, 200 empty returned).
 * IgnEx's interpreted `createApp().handler()` currently does NOT short-circuit
 * — the pipeline runs to completion. This file pins the CURRENT IgnEx
 * behaviour so the divergence is explicit and covered; implementing
 * short-circuiting later only needs to flip these assertions.
 *
 * The abort-race scenario (a slow handler racing an abort) is preserved: the
 * handler's own `Request` signal is observable via `ctx.req.signal`, so app
 * code can cancel its own work.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

const preAborted = (): AbortController => {
  const controller = new AbortController();
  controller.abort();
  return controller;
};

describe("abort signal (interpreted path)", () => {
  it("observes a pre-aborted request.signal from the handler (pinned current behaviour)", async () => {
    const app = createApp({
      handler: (ctx) => ctx.json({ aborted: ctx.req.signal.aborted }),
    });

    const res = await app.handler(
      new Request("http://localhost/", { signal: preAborted().signal }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ aborted: true });
  });

  it("runs the handler for a pre-aborted request (KNOWN DIVERGENCE from Elysia)", async () => {
    let handlerCalled = false;
    const app = createApp({
      handler: async (ctx) => {
        handlerCalled = true;
        await Promise.resolve();
        return ctx.text("ran");
      },
    });

    const res = await app.handler(
      new Request("http://localhost/", { signal: preAborted().signal }),
    );

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("ran");
    expect(handlerCalled).toBe(true);
  });

  it("races an abort against a slow handler without corrupting the response", async () => {
    // The handler reads ctx.req.signal; when the client aborts mid-flight the
    // handler can observe it and stop its own work. The response is still a
    // valid 200 (the client is gone, but in-process there is no corruption).
    const app = createApp({
      handler: async (ctx) => {
        const start = performance.now();
        while (!ctx.req.signal.aborted && performance.now() - start < 1000) {
          // spin-busy simulated work; abort breaks out
        }
        return ctx.text(ctx.req.signal.aborted ? "aborted" : "done");
      },
    });

    const controller = new AbortController();
    const pending = app.handler(new Request("http://localhost/", { signal: controller.signal }));
    controller.abort();
    const res = await pending;

    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("aborted");
  });

  it("keeps handler() usable without a signal (default aborted=false)", async () => {
    const res = await inject(
      app((ctx) => ctx.json({ aborted: ctx.req.signal.aborted })),
      {
        url: "/",
      },
    );

    await expect(res.json()).resolves.toEqual({ aborted: false });
  });
});
