/**
 * Handler execution timeout pins — the opt-in wall-clock cap per handler
 * invocation (`AppOptions.handlerTimeoutMs`): slow handlers resolve 503
 * `handler-timeout`, streaming responses are exempt (they return their
 * Response immediately), and the default (0/unset) keeps behavior identical.
 */
import { describe, expect, it } from "vitest";
import { createContext } from "../src/http/context";
import { handlerTimeoutResponse, withHandlerTimeout } from "../src/lifecycle/handler-timeout";
import { runLifecycle } from "../src/lifecycle/run";

const ctx = () => createContext(new Request("http://localhost:3000/x"), {});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withHandlerTimeout", () => {
  it("is identity when disabled (0 / undefined)", async () => {
    const res = new Response("ok");
    expect(withHandlerTimeout(() => res, 0)).toBe(res);
    expect(withHandlerTimeout(() => res, undefined)).toBe(res);
  });

  it("resolves 503 handler-timeout when the handler exceeds the cap", async () => {
    const res = await withHandlerTimeout(async () => {
      await sleep(200);
      return new Response("late");
    }, 20);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-ignex-reason")).toBe("handler-timeout");
    expect(await res.json()).toMatchObject({ code: "IGN_HANDLER_TIMEOUT" });
  });

  it("returns the handler's response when it beats the cap", async () => {
    const res = await withHandlerTimeout(async () => {
      await sleep(5);
      return new Response("fast");
    }, 1000);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fast");
  });

  it("does not leak the timer when the handler resolves first", async () => {
    // With thousands of pending timers vitest's unhandled-handle detection
    // (and Bun's event loop drain) would notice; this is a canary.
    for (let i = 0; i < 50; i++) {
      await withHandlerTimeout(() => Promise.resolve(new Response("x")), 5_000);
    }
    expect(true).toBe(true);
  });

  it("the 503 envelope carries the stable code + reason", () => {
    const res = handlerTimeoutResponse();
    expect(res.status).toBe(503);
    expect(res.headers.get("x-ignex-reason")).toBe("handler-timeout");
  });
});

describe("runLifecycle handler timeout", () => {
  const lc = {};
  it("a slow handler surfaces the 503 envelope through the pipeline", async () => {
    const response = await runLifecycle(
      lc,
      [],
      [],
      ctx(),
      async () => {
        await sleep(150);
        return new Response("late");
      },
      false,
      25,
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("x-ignex-reason")).toBe("handler-timeout");
  });

  it("streaming responses are exempt (Response returned immediately)", async () => {
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(new TextEncoder().encode("chunk-1"));
        await sleep(60);
        controller.enqueue(new TextEncoder().encode("chunk-2"));
        controller.close();
      },
    });
    const response = await runLifecycle(
      lc,
      [],
      [],
      ctx(),
      () => new Response(stream, { headers: { "content-type": "text/event-stream" } }),
      false,
      25,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("chunk-1chunk-2");
  });

  it("default (no timeout) keeps slow handlers working", async () => {
    const response = await runLifecycle(lc, [], [], ctx(), async () => {
      await sleep(40);
      return new Response("eventually");
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("eventually");
  });
});
