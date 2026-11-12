import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeState = vi.hoisted(() => ({
  mode: "unavailable" as "unavailable" | "missing" | "fault" | "allow",
}));

vi.mock("@ignex/native", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ignex/native")>();
  const pipeline = () => {
    if (nativeState.mode === "missing") return null;
    return {
      needsIp: false,
      preprocess: () => ({
        terminal: false,
        response: null,
        result:
          nativeState.mode === "fault"
            ? null
            : {
                ok: true,
                status: 200,
                terminal: false,
                rateLimited: false,
                requestId: "test",
                body: new Uint8Array(0),
              },
      }),
    };
  };
  return {
    ...actual,
    isNativeAvailable: () => nativeState.mode !== "unavailable",
    createNativeIngress: pipeline,
    createNativePipeline: async () => pipeline(),
  };
});

import { createApp } from "../src/lifecycle/app-factory";
import { nativePreflight } from "../src/plugins/native";

const request = (init: RequestInit = {}) => new Request("http://localhost/", init);

beforeEach(() => {
  nativeState.mode = "unavailable";
});

describe("nativePreflight fail-closed enforcement", () => {
  it("keeps an unconfigured plugin as a no-op when native is unavailable", async () => {
    const app = createApp({
      plugins: [nativePreflight()],
      handler: () => new Response("ok"),
    });

    const response = await app.handler(request());
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("rejects requests instead of dropping configured rate limiting without native", async () => {
    let handlerRan = false;
    const app = createApp({
      plugins: [nativePreflight({ rateLimit: { limit: 1, windowMs: 60_000 } })],
      handler: () => {
        handlerRan = true;
        return new Response("ok");
      },
    });

    const response = await app.handler(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("x-ignex-reason")).toBe("native-preflight-unavailable");
    expect(await response.json()).toMatchObject({ code: "NATIVE_PREFLIGHT_UNAVAILABLE" });
    expect(handlerRan).toBe(false);
  });

  it("rejects requests when native is present but no compatible pipeline can be created", async () => {
    nativeState.mode = "missing";
    const app = createApp({
      plugins: [nativePreflight({ options: { enableBodySizeGuard: true, maxBodyBytes: 32 } })],
      handler: () => new Response("ok"),
    });
    await app.init();

    expect((await app.handler(request())).status).toBe(503);
  });

  it("rejects requests when the native pipeline cannot produce a verdict", async () => {
    nativeState.mode = "fault";
    const app = createApp({
      plugins: [nativePreflight({ rateLimit: { limit: 1 } })],
      handler: () => new Response("ok"),
    });
    await app.init();

    expect((await app.handler(request())).status).toBe(503);
  });

  it("preserves ordinary requests when a configured native pipeline returns a valid allow", async () => {
    nativeState.mode = "allow";
    const app = createApp({
      plugins: [nativePreflight({ rateLimit: { limit: 1 } })],
      handler: () => new Response("ok"),
    });
    await app.init();

    const response = await app.handler(request());
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("ok");
  });

  it("keeps CORS preflight enforcement available without native", async () => {
    const app = createApp({
      plugins: [nativePreflight({ cors: { allowOrigin: ["https://good.example"] } })],
      handler: () => new Response("ok"),
    });
    const preflight = (origin: string) =>
      request({
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });

    expect((await app.handler(preflight("https://good.example"))).status).toBe(204);
    expect((await app.handler(preflight("https://bad.example"))).status).toBe(403);
  });
});
