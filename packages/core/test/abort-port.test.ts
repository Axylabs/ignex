/**
 * @fileoverview Port of Elysia `test/core/abort.test.ts` +
 * `test/core/abort-race.test.ts` — AbortSignal handling on the interpreted
 * path.
 *
 * A request that is ALREADY aborted before the pipeline runs is
 * short-circuited (matches Elysia): hooks and the handler are never called,
 * and an empty 200 is returned — the client is gone, so doing work is waste.
 * This applies to both the interpreted `createApp().handler()` path and the
 * routed path.
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
  it("short-circuits a pre-aborted request (handler never called, empty 200)", async () => {
    let handlerCalled = false;
    const res = await app(async (ctx) => {
      handlerCalled = true;
      return ctx.json({ aborted: ctx.req.signal.aborted });
    }).handler(new Request("http://localhost/", { signal: preAborted().signal }));

    expect(handlerCalled).toBe(false);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");
  });

  it("skips pre-handler hooks for a pre-aborted request", async () => {
    let hookCalled = false;
    const res = await createApp({
      lifecycle: {
        beforeHandle: [
          (ctx) => {
            hookCalled = true;
            return ctx;
          },
        ],
      },
      handler: (ctx) => ctx.text("ran"),
    }).handler(new Request("http://localhost/", { signal: preAborted().signal }));

    expect(hookCalled).toBe(false);
    expect(res.status).toBe(200);
    await expect(res.text()).resolves.toBe("");
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
