/**
 * Tests for the `openapi()` plugin — runtime OpenAPI docs + Scalar/Swagger UI.
 *
 * Interpreted mode (`createApp({ router, plugins: [openapi()] })`) registers
 * real spec/docs routes and enumerates the router; AOT mode (the `onRequest`
 * fallback, when no router exists) intercepts the two paths and serves the
 * compiled artifact (falling back to an empty document).
 */

import { describe, expect, it } from "vitest";
import { createApp, createRouter, openapi } from "../src/index.js";
import { inject } from "./helpers/inject";

describe("openapi() — interpreted mode (createApp + router)", () => {
  it("serves a spec with real paths and excludes its own endpoints", async () => {
    const app = createApp({
      router: createRouter()
        .get("/health", () => "ok")
        .get("/users/:id", (ctx) => ctx.json({ id: ctx.params.id }), {
          params: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        }),
      plugins: [openapi({ documentation: { title: "Test API", version: "1.0.0" } })],
    });

    const res = await inject(app, { url: "/openapi.json" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const spec = (await res.json()) as {
      info?: { title?: string; version?: string };
      paths?: Record<string, unknown>;
    };
    expect(spec.info?.title).toBe("Test API");
    expect(spec.paths).toHaveProperty("/health");
    expect(spec.paths).toHaveProperty("/users/{id}");
    // The plugin's own endpoints must not appear in the document.
    expect(spec.paths).not.toHaveProperty("/openapi.json");
    expect(spec.paths).not.toHaveProperty("/openapi");
  });

  it("serves the Scalar docs UI at the default path", async () => {
    const app = createApp({
      router: createRouter().get("/health", () => "ok"),
      plugins: [openapi()],
    });
    const res = await inject(app, { url: "/openapi" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("api-reference");
  });

  it("respects per-route detail.hide and exclude.paths", async () => {
    const app = createApp({
      router: createRouter()
        .get("/public", () => "ok")
        .get("/secret", () => "ok", { detail: { hide: true } })
        .get("/skipme", () => "ok"),
      plugins: [openapi({ exclude: { paths: ["/skipme"] } })],
    });
    const res = await inject(app, { url: "/openapi.json" });
    const spec = (await res.json()) as { paths?: Record<string, unknown> };
    expect(spec.paths).toHaveProperty("/public");
    expect(spec.paths).not.toHaveProperty("/secret");
    expect(spec.paths).not.toHaveProperty("/skipme");
  });

  it("honors custom specPath/path and provider null (spec-only)", async () => {
    const app = createApp({
      router: createRouter().get("/health", () => "ok"),
      plugins: [openapi({ specPath: "/docs.json", path: "/docs", provider: null })],
    });
    expect((await inject(app, { url: "/docs.json" })).status).toBe(200);
    // provider: null → no UI page is registered.
    expect((await inject(app, { url: "/docs" })).status).toBe(404);
  });
});

describe("openapi() — AOT fallback (onRequest interception, no router)", () => {
  const plugin = openapi();

  const run = async (path: string): Promise<Response | object> => {
    const result = plugin.onRequest?.({ url: new URL(`http://localhost${path}`) } as never);
    return (await result) as Response | object;
  };

  it("serves the docs UI at /openapi", async () => {
    const res = await run("/openapi");
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toContain("api-reference");
  });

  it("passes non-matching paths through unchanged", async () => {
    const ctx = { url: new URL("http://localhost/health") } as never;
    const out = await plugin.onRequest?.(ctx);
    expect(out).toBe(ctx);
  });

  it("serves a JSON document at /openapi.json (empty without an artifact)", async () => {
    const res = await run("/openapi.json");
    expect(res).toBeInstanceOf(Response);
    const response = res as Response;
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toHaveProperty("paths");
  });
});
