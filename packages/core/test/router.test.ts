/**
 * @fileoverview Interpreted router + shared finalize helpers.
 *
 * Covers `createRouter()` + `createApp({ router })`: the Bun-native `routes`
 * table shape (method keys, auto-HEAD, auto-OPTIONS, 405 allow-map), JS
 * dispatch through `app.handler()` (params, wildcards, 404/405), the guarded
 * lifecycle (beforeHandle, set application), runtime schema validation, and
 * the `finalizeResponse` reply contract shared with the AOT pipeline.
 */

import { createApp, createRouter, finalizeResponse, jsonReply } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

describe("finalizeResponse (shared reply contract)", () => {
  it("passes a Response through untouched", () => {
    const res = new Response("ok", { status: 201 });
    expect(finalizeResponse(res, undefined)).toBe(res);
  });

  it("maps undefined/null to a 204 (or set status)", () => {
    expect(finalizeResponse(undefined, undefined).status).toBe(204);
    expect(finalizeResponse(null, { set: { status: 202 } }).status).toBe(202);
  });

  it("honors { status, body } and defaults to 200", async () => {
    const res = finalizeResponse({ status: 201, body: { a: 1 } }, undefined);
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toEqual({ a: 1 });
  });

  it("serializes plain values through the reply builder", () => {
    const res = finalizeResponse({ ok: true }, undefined, undefined, jsonReply);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("content-length")).toBe(
      String(new TextEncoder().encode(JSON.stringify({ ok: true })).byteLength),
    );
  });

  it("uses a per-status serializer when present", async () => {
    const res = finalizeResponse({ a: 1 }, undefined, {
      200: (v) => JSON.stringify({ wrapped: v }),
    });
    await expect(res.json()).resolves.toEqual({ wrapped: { a: 1 } });
  });
});

describe("createRouter — buildRoutes (Bun-native shape)", () => {
  const router = createRouter()
    .get("/health", () => "health")
    .post("/api/users", () => "create")
    .route({ method: "PUT", path: "/api/users/:id", handler: () => "update" });

  const routes = router.buildRoutes();

  it("keys routes by path and method", () => {
    expect(Object.keys(routes)).toEqual(
      expect.arrayContaining(["/health", "/api/users", "/api/users/:id"]),
    );
    expect(Object.keys(routes["/health"])).toEqual(expect.arrayContaining(["GET"]));
    expect(Object.keys(routes["/api/users"])).toEqual(expect.arrayContaining(["POST"]));
    // PUT was registered on the param path.
    expect(Object.keys(routes["/api/users/:id"])).toEqual(expect.arrayContaining(["PUT"]));
  });

  it("auto-adds HEAD for GET routes and OPTIONS on every path", () => {
    expect(routes["/health"]["HEAD"]).toBeTypeOf("function");
    expect(routes["/health"]["OPTIONS"]).toBeTypeOf("function");
    // No GET on /api/users → no auto-HEAD; OPTIONS still present.
    expect(routes["/api/users"]["HEAD"]).toBeUndefined();
    expect(routes["/api/users"]["OPTIONS"]).toBeTypeOf("function");
  });
});

describe("createApp + router (dispatch through handler)", () => {
  it("routes exact paths and applies ctx.set exactly once", async () => {
    const app = createApp({
      router: createRouter().get("/health", (ctx) => {
        ctx.set.headers["x-custom"] = "yes";
        return ctx.json({ ok: true });
      }),
    });

    const res = await inject(app, { url: "/health" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-custom")).toBe("yes");
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("applies a Set-Cookie exactly once (regression: duplicate-apply bug)", async () => {
    const app = createApp({
      router: createRouter().get("/c", (ctx) => {
        ctx.set.cookie.token = { value: "abc" };
        return ctx.json({ ok: true });
      }),
    });

    const res = await inject(app, { url: "/c" });
    const setCookies = [...res.headers.entries()].filter(([k]) => k.toLowerCase() === "set-cookie");
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0][1]).toContain("token=abc");
  });

  it("captures :params and * wildcards", async () => {
    const app = createApp({
      router: createRouter()
        .get("/api/users/:id", (ctx) => ctx.json({ id: ctx.params.id }))
        .get("/files/*", (ctx) => ctx.json({ rest: ctx.params["*"] })),
    });

    await expect(inject(app, { url: "/api/users/42" }).then((r) => r.json())).resolves.toEqual({
      id: "42",
    });
    await expect(inject(app, { url: "/files/a/b.txt" }).then((r) => r.json())).resolves.toEqual({
      rest: "a/b.txt",
    });
  });

  it("keeps raw text for malformed percent-encoding (no 500)", async () => {
    const app = createApp({
      router: createRouter().get("/api/users/:id", (ctx) => ctx.json({ id: ctx.params.id })),
    });
    const res = await inject(app, { url: "/api/users/%zz" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ id: "%zz" });
  });

  it("auto-HEAD returns GET headers with an empty body", async () => {
    const app = createApp({
      router: createRouter().get("/health", (ctx) => ctx.json({ ok: true })),
    });
    const res = await inject(app, { method: "HEAD", url: "/health" });
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("auto-OPTIONS returns 204 with an Allow header", async () => {
    const app = createApp({
      router: createRouter().get("/health", (ctx) => ctx.json({ ok: true })),
    });
    const res = await inject(app, { method: "OPTIONS", url: "/health" });
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("404s unmatched paths with the compiled fallback shape", async () => {
    const app = createApp({ router: createRouter().get("/health", () => "h") });
    const res = await inject(app, { url: "/nope" });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.code).toBe("NOT_FOUND");
  });

  it("405s a known path with the wrong method", async () => {
    const app = createApp({ router: createRouter().get("/health", () => "h") });
    const res = await inject(app, { method: "DELETE", url: "/health" });
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.code).toBe("METHOD_NOT_ALLOWED");
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("runs a beforeHandle lifecycle hook before the handler", async () => {
    const order: string[] = [];
    const app = createApp({
      lifecycle: {
        beforeHandle: [
          () => {
            order.push("hook");
          },
        ],
      },
      router: createRouter().get("/health", () => {
        order.push("handler");
        return "ok";
      }),
    });
    await inject(app, { url: "/health" });
    expect(order).toEqual(["hook", "handler"]);
  });

  it("validates a body schema and returns 422 on failure", async () => {
    const app = createApp({
      router: createRouter().post(
        "/users",
        async (ctx) => {
          const body = (await ctx.body.json()) as { name: string };
          return ctx.json({ name: body.name });
        },
        { body: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
      ),
    });

    const ok = await inject(app, { method: "POST", url: "/users", body: '{"name":"ada"}' });
    expect(ok.status).toBe(200);
    await expect(ok.json()).resolves.toEqual({ name: "ada" });

    const bad = await inject(app, { method: "POST", url: "/users", body: "{}" });
    expect(bad.status).toBe(422);
  });

  it("routes with `all()` register every method", async () => {
    const app = createApp({ router: createRouter().all("/x", () => "x") });
    for (const method of ["GET", "POST", "PUT", "DELETE"]) {
      const res = await inject(app, { method, url: "/x" });
      expect(res.status).toBe(200);
    }
  });

  it("supports a plain-value return (serialized as JSON)", async () => {
    const app = createApp({ router: createRouter().get("/plain", () => ({ n: 1 })) });
    const res = await inject(app, { url: "/plain" });
    expect(res.headers.get("content-length")).toBe("7");
    await expect(res.json()).resolves.toEqual({ n: 1 });
  });
});

describe("createApp + router (hardening & edge cases)", () => {
  it("runs the error stage on a throwing handler", async () => {
    const app = createApp({
      lifecycle: {
        error: [(ctx, err) => ctx.json({ caught: (err as Error).message }, { status: 418 })],
      },
      router: createRouter().get("/boom", () => {
        throw new Error("kaboom");
      }),
    });

    const res = await inject(app, { url: "/boom" });
    expect(res.status).toBe(418);
    await expect(res.json()).resolves.toEqual({ caught: "kaboom" });
  });

  it("a throwing error-stage hook falls back to the default error response", async () => {
    const app = createApp({
      lifecycle: {
        error: [
          () => {
            throw new Error("hook bug");
          },
        ],
      },
      router: createRouter().get("/boom", () => {
        throw new Error("original");
      }),
    });

    const res = await inject(app, { url: "/boom" });
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({
      error: "Internal Server Error",
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("a throwing afterResponse hook does not corrupt the response", async () => {
    const app = createApp({
      lifecycle: {
        afterResponse: [
          () => {
            throw new Error("observe bug");
          },
        ],
      },
      router: createRouter().get("/ok", (ctx) => ctx.json({ ok: true })),
    });

    const res = await inject(app, { url: "/ok" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("applies a redirect set on the context (302 + Location)", async () => {
    const app = createApp({
      router: createRouter().get("/old", (ctx) => {
        ctx.set.redirect = "/new";
        return ctx.json({ ok: true });
      }),
    });

    const res = await inject(app, { url: "/old" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/new");
  });

  it("validates a query schema (422 on failure) and exposes the parsed query", async () => {
    const app = createApp({
      router: createRouter().get("/q", (ctx) => ctx.json({ q: ctx.query }), {
        query: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
      }),
    });

    const ok = await inject(app, { url: "/q?n=5" });
    expect(ok.status).toBe(200);
    // Ajv `coerceTypes` coerces the parsed query in place (matching the
    // compiled full-context prelude), so `ctx.query.n` is the number 5.
    await expect(ok.json()).resolves.toEqual({ q: { n: 5 } });

    const bad = await inject(app, { url: "/q?n=abc" });
    expect(bad.status).toBe(422);
  });

  it("validates a headers schema (422 on missing required header)", async () => {
    const app = createApp({
      router: createRouter().get("/h", () => "ok", {
        headers: {
          type: "object",
          properties: { "x-token": { type: "string" } },
          required: ["x-token"],
        },
      }),
    });

    expect((await inject(app, { url: "/h", headers: { "x-token": "abc" } })).status).toBe(200);
    expect((await inject(app, { url: "/h" })).status).toBe(422);
  });

  it("validates a cookie schema (422 on missing required cookie)", async () => {
    const app = createApp({
      router: createRouter().get("/ck", () => "ok", {
        cookie: { type: "object", properties: { sid: { type: "string" } }, required: ["sid"] },
      }),
    });

    expect((await inject(app, { url: "/ck", headers: { cookie: "sid=abc" } })).status).toBe(200);
    expect((await inject(app, { url: "/ck" })).status).toBe(422);
  });

  it("dispatches a URL carrying a query string", async () => {
    const app = createApp({
      router: createRouter().get("/q", (ctx) => ctx.json({ url: ctx.req.url })),
    });
    const res = await inject(app, { url: "/q?a=1&b=2" });
    await expect(res.json()).resolves.toEqual({ url: "http://localhost/q?a=1&b=2" });
  });

  it("prefers an exact static route over a wildcard (Bun-native specificity)", async () => {
    const app = createApp({
      router: createRouter()
        .get("/api/*", () => "wild")
        .get("/api/health", () => "exact"),
    });

    // Plain-string returns are JSON-encoded by `jsonReply`.
    await expect(inject(app, { url: "/api/health" }).then((r) => r.text())).resolves.toBe(
      '"exact"',
    );
    await expect(inject(app, { url: "/api/other" }).then((r) => r.text())).resolves.toBe('"wild"');
  });

  it("buildRoutes is deterministic across calls", () => {
    const router = createRouter()
      .get("/a", () => "a")
      .post("/a", () => "b")
      .get("/b/:id", () => "c");
    const first = router.buildRoutes();
    const second = router.buildRoutes();
    expect(Object.keys(first)).toEqual(Object.keys(second));
    expect(Object.keys(first["/a"])).toEqual(Object.keys(second["/a"]));
  });
});

describe("createApp without router (back-compat)", () => {
  it("still runs the single-handler mode", async () => {
    const app = createApp({ handler: (ctx) => ctx.json({ ok: true }) });
    const res = await inject(app, { url: "/" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });

  it("throws a clear error when neither handler nor router is given", () => {
    expect(() => createApp({} as never)).toThrow(/handler.*router/);
  });
});
