/**
 * @fileoverview Interpreted request handling — `createApp().handler()` driven
 * in-process via the `inject` helper (the Fastify-`inject()` analog).
 *
 * Complements the lower-level `lifecycle.test.ts` (which unit-tests
 * `runLifecycle` stages) by exercising the whole interpreted request path with
 * real `Request` objects: body parsing, `ctx.set` application, error handling,
 * plugin onion ordering, redirects, concurrency and context accessors — the
 * cases a backend framework must handle before AOT compilation is involved.
 */
import { describe, expect, it } from "vitest";
import { createApp, type IgnexPlugin } from "../src/index.js";
import { inject } from "./helpers/inject";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const jsonApp = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

describe("interpreted request handling (createApp.handler)", () => {
  it("returns a JSON response with the correct content type", async () => {
    const app = jsonApp((ctx) => ctx.json({ ok: true }));
    const res = await inject(app, { url: "/x" });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("exposes method, path, query and headers on the context", async () => {
    const app = jsonApp((ctx) =>
      ctx.json({
        method: ctx.method,
        path: ctx.path,
        q: ctx.query.get("q"),
        header: ctx.headers.get("x-test"),
      }),
    );
    const res = await inject(app, {
      url: "/hello/world?q=42",
      headers: { "x-test": "yes" },
    });

    expect(await res.json()).toEqual({
      method: "GET",
      path: "/hello/world",
      q: "42",
      header: "yes",
    });
  });

  it("computes ctx.path independent of query/fragment (lazy pathname)", async () => {
    const app = jsonApp((ctx) => ctx.json({ path: ctx.path }));
    const cases: Array<[string, string]> = [
      ["/hello/world", "/hello/world"],
      ["/hello?q=42", "/hello"],
      ["/a/b#frag", "/a/b"],
      ["/?q=1", "/"],
      ["/", "/"],
      ["http://localhost", "/"],
      ["http://localhost:9122/api/users?page=1", "/api/users"],
    ];
    for (const [url, expected] of cases) {
      const res = await inject(app, { url });
      expect((await res.json()) as { path: string }).toEqual({ path: expected });
    }
  });

  it("parses a JSON request body", async () => {
    const app = jsonApp(async (ctx) => ctx.json({ body: await ctx.body.json() }));
    const res = await inject(app, {
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });

    expect((await res.json()) as { body: unknown }).toEqual({ body: { a: 1 } });
  });

  it("parses form-urlencoded and text bodies", async () => {
    const app = jsonApp(async (ctx) =>
      ctx.json({ form: await ctx.body.form(), text: await ctx.body.text() }),
    );
    const res = await inject(app, {
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "a=1&b=two",
    });

    expect(await res.json()).toEqual({ form: { a: "1", b: "two" }, text: "a=1&b=two" });
  });

  it("parses a raw (octet-stream) body", async () => {
    const app = jsonApp(async (ctx) => {
      const buf = await ctx.body.arrayBuffer();
      return ctx.json({ bytes: buf.byteLength });
    });
    const res = await inject(app, {
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([1, 2, 3, 4]),
    });

    expect(await res.json()).toEqual({ bytes: 4 });
  });

  it("rejects malformed JSON with 400", async () => {
    const app = jsonApp(async (ctx) => ctx.json({ body: await ctx.body.json() }));
    const res = await inject(app, {
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });

    expect(res.status).toBe(400);
  });

  it("rejects bodies over the size limit with 413", async () => {
    const app = jsonApp(async (ctx) => ctx.json({ body: await ctx.body.json() }));
    const big = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
    const res = await inject(app, {
      method: "POST",
      url: "/x",
      headers: { "content-type": "application/json" },
      body: big,
    });

    expect(res.status).toBe(413);
  });

  it("halts the pipeline when a pre-handler hook returns a Response", async () => {
    let handlerCalled = false;
    const app = createApp({
      lifecycle: { beforeHandle: [() => new Response("halted", { status: 418 })] },
      handler: () => {
        handlerCalled = true;
        return new Response("never");
      },
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(418);
    expect(await res.text()).toBe("halted");
    expect(handlerCalled).toBe(false);
  });

  it("preserves a 401 response returned by a hook (not clobbered to 200)", async () => {
    const app = createApp({
      lifecycle: { beforeHandle: [() => new Response("unauthorized", { status: 401 })] },
      handler: (ctx) => ctx.json({ ok: true }),
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
  });

  it("replaces the response in afterHandle", async () => {
    const app = createApp({
      lifecycle: { afterHandle: [(_ctx, response) => new Response(`wrapped:${response.status}`)] },
      handler: () => new Response("original", { status: 200 }),
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("wrapped:200");
  });

  it("applies ctx.set status/headers/cookie to the final response", async () => {
    const app = jsonApp((ctx) => {
      ctx.set.status = 201;
      ctx.set.headers = { "x-custom": "yes" };
      ctx.set.cookie = { sid: { value: "abc" } };
      return ctx.json({ ok: true });
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
    expect(res.headers.get("set-cookie")).toContain("sid=abc");
  });

  it("honours ctx.redirect with a Location header", async () => {
    const app = jsonApp((ctx) => ctx.redirect("/elsewhere", 302));
    const res = await inject(app, { url: "/x" });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/elsewhere");
  });

  it("swallows a throwing afterResponse hook (200 preserved)", async () => {
    const app = createApp({
      lifecycle: {
        afterResponse: [
          () => {
            throw new Error("observe fail");
          },
        ],
      },
      handler: () => new Response("fine", { status: 200 }),
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fine");
  });

  it("runs the trace stage after afterResponse with the final response", async () => {
    const order: string[] = [];
    const app = createApp({
      lifecycle: {
        afterResponse: [
          (_ctx, res) => {
            order.push(`afterResponse:${res.status}`);
          },
        ],
        trace: [
          (_ctx, res) => {
            order.push(`trace:${res.status}`);
          },
        ],
      },
      handler: (ctx) => {
        order.push("handler");
        return ctx.json({ ok: true });
      },
    });

    await inject(app, { url: "/x" });
    expect(order).toEqual(["handler", "afterResponse:200", "trace:200"]);
  });

  it("swallows a throwing trace hook (200 preserved)", async () => {
    const app = createApp({
      lifecycle: {
        trace: [
          () => {
            throw new Error("trace fail");
          },
        ],
      },
      handler: () => new Response("fine", { status: 200 }),
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("fine");
  });

  it("returns 500 with a generic envelope for a thrown error", async () => {
    const app = jsonApp(() => {
      throw new Error("boom");
    });
    const res = await inject(app, { url: "/x" });

    expect(res.status).toBe(500);
    const body = (await res.json()) as { code?: string; error?: string };
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(body.error).not.toContain("boom");
  });

  it("exposes the real error message when exposeErrors is set", async () => {
    const app = createApp({
      exposeErrors: true,
      handler: () => {
        throw new Error("boom");
      },
    });
    const res = await inject(app, { url: "/x" });

    expect(res.status).toBe(500);
    expect((await res.json()) as { error?: string }).toEqual({
      error: "boom",
      status: 500,
      code: "INTERNAL_ERROR",
    });
  });

  it("lets an error-stage hook handle the failure", async () => {
    const app = createApp({
      lifecycle: {
        error: [(_ctx, err) => new Response(`caught:${(err as Error).message}`, { status: 500 })],
      },
      handler: () => {
        throw new Error("boom");
      },
    });

    const res = await inject(app, { url: "/x" });
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("caught:boom");
  });

  it("reads cookies sent by the client", async () => {
    const app = jsonApp((ctx) =>
      ctx.json({ names: Object.keys(ctx.cookie), sid: ctx.cookie.sid?.value }),
    );
    const res = await inject(app, { url: "/x", headers: { cookie: "sid=abc; theme=dark" } });

    expect(await res.json()).toEqual({ names: ["sid", "theme"], sid: "abc" });
  });

  it("runs plugin onRequest forward and onResponse in reverse (onion)", async () => {
    const order: string[] = [];
    const mk = (name: string): IgnexPlugin => ({
      name,
      onRequest: (ctx) => {
        order.push(`${name}:req`);
        return ctx;
      },
      onResponse: (_ctx, res) => {
        order.push(`${name}:res`);
        return res;
      },
    });

    const app = createApp({
      plugins: [mk("a"), mk("b")],
      handler: (ctx) => {
        order.push("handler");
        return ctx.json({ ok: true });
      },
    });

    await inject(app, { url: "/x" });
    expect(order).toEqual(["a:req", "b:req", "handler", "b:res", "a:res"]);
  });

  it("serves text/html/empty responses through the context helpers", async () => {
    const textApp = jsonApp((ctx) => ctx.text("plain"));
    expect(await (await inject(textApp, { url: "/x" })).text()).toBe("plain");

    const htmlApp = jsonApp((ctx) => ctx.html("<p>hi</p>"));
    const html = await inject(htmlApp, { url: "/x" });
    expect(html.headers.get("content-type")).toContain("text/html");

    const emptyApp = jsonApp((ctx) => ctx.empty(204));
    expect((await inject(emptyApp, { url: "/x" })).status).toBe(204);
  });

  it("handles concurrent requests independently", async () => {
    const app = jsonApp(async (ctx) => {
      await delay(10);
      return ctx.json({ path: ctx.path });
    });

    const [a, b, c] = await Promise.all([
      inject(app, { url: "/a" }),
      inject(app, { url: "/b" }),
      inject(app, { url: "/c" }),
    ]);

    expect(await a.json()).toEqual({ path: "/a" });
    expect(await b.json()).toEqual({ path: "/b" });
    expect(await c.json()).toEqual({ path: "/c" });
  });
});
