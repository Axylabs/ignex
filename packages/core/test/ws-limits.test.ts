/**
 * WebSocket limits (A4): in-flight message cap with 1013 close, per-handler
 * transport limits spread onto the returned Bun `WebSocketHandler`, and the
 * strictest-wins `mergeWSLimits` used by the compiled server when multiple WS
 * routes share Bun's single `websocket` handler.
 */
import { describe, expect, it } from "vitest";
import { createWSHandler, mergeWSLimits } from "../src/index.js";
import type { ServerWebSocket } from "../src/types/index.js";

/** Fake ServerWebSocket that records close(code, reason) for cap assertions. */
const fakeSocket = (data: unknown = {}) => {
  const closed: Array<{ code: number; reason: string }> = [];
  const socket = {
    data,
    close: (code = 1000, reason = "") => {
      closed.push({ code, reason });
    },
    send: () => 1,
    sendText: () => 1,
    terminate: () => {},
  } as unknown as ServerWebSocket<unknown>;
  return { socket, closed };
};

/** A message hook that never settles (a wedged handler). */
const neverSettles = () => new Promise<void>(() => {});

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("createWSHandler in-flight cap", () => {
  it("closes 1013 and skips dispatch when in-flight messages reach the cap", () => {
    const { socket, closed } = fakeSocket();
    let calls = 0;
    const handler = createWSHandler(
      {
        message: () => {
          calls++;
          return neverSettles();
        },
      },
      undefined,
      { maxInflightMessages: 1 },
    );
    handler.open?.(socket);
    handler.message(socket, "one");
    handler.message(socket, "two");

    expect(calls).toBe(1); // the second message never reached the hook
    expect(closed).toEqual([{ code: 1013, reason: "Too many in-flight messages" }]);
  });

  it("decrements the count once an async handler settles", async () => {
    const { socket, closed } = fakeSocket();
    const resolvers: Array<() => void> = [];
    let calls = 0;
    const handler = createWSHandler(
      {
        message: () => {
          calls++;
          return new Promise<void>((resolve) => resolvers.push(resolve));
        },
      },
      undefined,
      { maxInflightMessages: 1 },
    );
    handler.open?.(socket);

    handler.message(socket, "a"); // in-flight = 1
    handler.message(socket, "b"); // capped → closed
    expect(calls).toBe(1);
    expect(closed).toEqual([{ code: 1013, reason: "Too many in-flight messages" }]);

    // Settle "a" — the slot frees and "c" must dispatch.
    resolvers[0]?.();
    await flush();
    handler.message(socket, "c");
    expect(calls).toBe(2);
    expect(closed).toHaveLength(1);
  });

  it("counts sync handlers as settling immediately", () => {
    const { socket, closed } = fakeSocket();
    let calls = 0;
    const handler = createWSHandler(
      {
        message: () => {
          calls++;
        },
      },
      undefined,
      { maxInflightMessages: 1 },
    );
    handler.open?.(socket);
    handler.message(socket, "a");
    handler.message(socket, "b");
    handler.message(socket, "c");
    expect(calls).toBe(3);
    expect(closed).toHaveLength(0);
  });

  it("defaults to a cap of 256", () => {
    const { socket, closed } = fakeSocket();
    let calls = 0;
    const handler = createWSHandler({
      message: () => {
        calls++;
        return neverSettles();
      },
    });
    handler.open?.(socket);
    for (let i = 0; i < 257; i++) handler.message(socket, `m${i}`);

    expect(calls).toBe(256); // the 257th is capped
    expect(closed).toEqual([{ code: 1013, reason: "Too many in-flight messages" }]);
  });
});

describe("createWSHandler transport limits", () => {
  it("spreads only the defined transport fields onto the returned handler", () => {
    const handler = createWSHandler({}, undefined, {
      maxPayloadLength: 1024,
      backpressureLimit: 2048,
      idleTimeout: 30,
    });

    expect(handler.maxPayloadLength).toBe(1024);
    expect(handler.backpressureLimit).toBe(2048);
    expect(handler.idleTimeout).toBe(30);
    expect(handler.closeOnBackpressureLimit).toBeUndefined();
    expect(handler.message).toBeTypeOf("function");
  });
});

describe("mergeWSLimits", () => {
  it("picks the strictest value per field across handlers", () => {
    expect(
      mergeWSLimits([
        { maxPayloadLength: 4096, backpressureLimit: 8192, idleTimeout: 60 },
        { maxPayloadLength: 1024, closeOnBackpressureLimit: true, idleTimeout: 30 },
      ]),
    ).toEqual({
      maxPayloadLength: 1024,
      backpressureLimit: 8192,
      closeOnBackpressureLimit: true,
      idleTimeout: 30,
    });
  });

  it("omits fields no handler sets (so Bun defaults are never clobbered)", () => {
    expect(mergeWSLimits([])).toEqual({});
    expect(mergeWSLimits([{ maxPayloadLength: 1 }, {}])).toEqual({ maxPayloadLength: 1 });
    expect(mergeWSLimits([{ closeOnBackpressureLimit: false }])).toEqual({});
  });
});
