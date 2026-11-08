/**
 * @fileoverview Request-id correlation, validation, and opt-in response hooks.
 */

import { describe, expect, it } from "vitest";
import { createApp, type RequestIdOptions, requestId } from "../src/index";

const appWith = (options: RequestIdOptions = {}) =>
  createApp({
    plugins: [requestId(options)],
    handler: (ctx) =>
      ctx.json({
        direct: ctx.requestId,
        state: ctx.getState("requestId"),
      }),
  });

const call = (app: ReturnType<typeof appWith>, id?: string) =>
  app.handler(
    new Request(
      "http://localhost/test",
      id === undefined ? {} : { headers: { "x-request-id": id } },
    ),
  );

describe("requestId plugin", () => {
  it("uses one id for direct context reads, state, and the response", async () => {
    const res = await call(appWith(), "client-123");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("client-123");
    expect(await res.json()).toEqual({ direct: "client-123", state: "client-123" });
  });

  it("replaces invalid or oversized inbound ids", async () => {
    const generated = await call(appWith(), "not valid");
    const generatedId = generated.headers.get("x-request-id");
    expect(generatedId).not.toBe("not valid");
    expect(generatedId).toMatch(/^[\x21-\x7E]+$/);

    const oversized = await call(appWith({ maxLength: 8 }), "123456789");
    expect(oversized.headers.get("x-request-id")).not.toBe("123456789");
  });

  it("supports custom headers/generators and can disable inbound trust/echo", async () => {
    const app = createApp({
      plugins: [
        requestId({
          header: "x-correlation-id",
          acceptIncoming: false,
          echo: false,
          generate: () => "server-generated",
        }),
      ],
      handler: (ctx) => ctx.text(ctx.requestId),
    });
    const res = await app.handler(
      new Request("http://localhost/", { headers: { "x-correlation-id": "client" } }),
    );
    expect(await res.text()).toBe("server-generated");
    expect(res.headers.get("x-correlation-id")).toBeNull();
  });

  it("fails fast on invalid configuration", () => {
    expect(() => requestId({ header: "bad header" })).toThrow(/valid HTTP header name/);
    expect(() => requestId({ maxLength: 0 })).toThrow(/between 1 and 10000/);
  });

  it("fails closed when a custom generator emits an unsafe id", async () => {
    const res = await call(appWith({ generate: () => "unsafe id" }));
    expect(res.status).toBe(500);
  });
});
