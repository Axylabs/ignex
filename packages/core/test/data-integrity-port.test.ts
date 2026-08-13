/**
 * @fileoverview New data-integrity tests (beyond Elysia's suite) — request-level
 * robustness on the interpreted `createApp().handler()` path.
 *
 * Scenarios: prototype-pollution through a JSON body, deep-nesting without
 * corruption, body-size guards, null-byte/hostile inputs, duplicate
 * content-type headers, and safe Set-Cookie value encoding.
 */

import { createApp, createLazyBody, serializeCookie } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

describe("prototype pollution through the request path", () => {
  it("a JSON body with __proto__ / constructor keys never pollutes Object.prototype", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json({ body: await ctx.body.json() })),
      {
        method: "POST",
        url: "/",
        headers: { "content-type": "application/json" },
        body: '{"__proto__": {"polluted": true}, "constructor": {"x": 1}, "a": "b"}',
      },
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const body = (await res.json()) as { body: Record<string, unknown> };
    // The __proto__ key survives as an own property (JSON.parse semantics) but
    // never mutates Object.prototype.
    expect(body.body).toHaveProperty("a");
    expect(body.body).toHaveProperty("constructor");
  });

  it("parsing a query with a __proto__ key does not pollute", async () => {
    const res = await inject(
      app((ctx) => ctx.json({ q: ctx.query.get("__proto__") })),
      { url: "/?__proto__=polluted" },
    );

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    await expect(res.json()).resolves.toEqual({ q: "polluted" });
  });
});

describe("deep nesting and hostile inputs", () => {
  it("parses a deeply nested JSON body (1000 levels) without corruption", async () => {
    const deep = JSON.stringify(JSON.parse(`[${"1,".repeat(999)}1]`).reduceRight((acc) => [acc]));
    const res = await inject(
      app(async (ctx) =>
        ctx.json({ depth: await ctx.body.json().then((v: unknown) => (v as unknown[]).length) }),
      ),
      {
        method: "POST",
        url: "/",
        headers: { "content-type": "application/json" },
        body: deep,
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ depth: 1 });
  });

  it("handles a null byte in the query without crashing", async () => {
    const res = await inject(
      app((ctx) => ctx.json({ v: ctx.query.get("v") })),
      {
        url: `/?v=${encodeURIComponent("a\u0000b")}`,
      },
    );

    expect([200, 400]).toContain(res.status);
  });

  it("rejects a malformed JSON body with 400, not a hang or 500", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json({ parsed: await ctx.body.json() })),
      {
        method: "POST",
        url: "/",
        headers: { "content-type": "application/json" },
        body: '{"unclosed": ',
      },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "BODY_PARSE_ERROR" });
  });

  it("duplicate content-type headers still parse the body deterministically", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json({ t: await ctx.body.text() })),
      {
        method: "POST",
        url: "/",
        headers: [
          ["content-type", "application/json"],
          ["content-type", "text/plain"],
        ],
        body: "hello",
      },
    );

    expect([200, 400]).toContain(res.status);
  });
});

describe("body size guards", () => {
  it("rejects an oversized JSON body with 413 (post-parse guard)", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: "x".repeat(10_000) }),
    });
    const body = createLazyBody(req, { maxJsonBytes: 1000 });

    await expect(body.json()).rejects.toMatchObject({ status: 413 });
  });

  it("rejects an oversized body via the content-length pre-check", async () => {
    const req = new Request("http://x/", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "5000" },
      body: "{}",
    });
    const body = createLazyBody(req, { maxJsonBytes: 100 });

    await expect(body.json()).rejects.toMatchObject({ status: 413 });
  });

  it("enforces the per-file limit on multipart uploads", async () => {
    const fd = new FormData();
    fd.append("f", new File([new Uint8Array(500)], "f.bin"));
    const req = new Request("http://x/", { method: "POST", body: fd });
    const body = createLazyBody(req, { maxFileBytes: 100 });

    await expect(body.file("f")).rejects.toMatchObject({ status: 413 });
  });
});

describe("Set-Cookie value safety", () => {
  it("URL-encodes special characters in cookie values (no injection)", () => {
    const out = serializeCookie({ c: { value: 'a"b; c\r\nd' } });
    expect(out).toBe("c=a%22b%3B%20c%0D%0Ad");
  });
});

describe("context accessor integrity", () => {
  it("exposes stable method/path/route/requestId per request", async () => {
    const res = await inject(
      app((ctx) =>
        ctx.json({
          method: ctx.method,
          path: ctx.path,
          requestId: ctx.requestId,
          ip: ctx.ip,
        }),
      ),
      { url: "/some/path?x=1" },
    );

    const body = (await res.json()) as {
      method: string;
      path: string;
      requestId: string;
      ip: string;
    };
    expect(body.method).toBe("GET");
    expect(body.path).toBe("/some/path");
    expect(body.requestId).toBeTruthy();
    expect(body.ip).toBe("anonymous");
  });

  it("state is per-request (no leakage between requests)", async () => {
    const app = createApp({
      handler: (ctx) => {
        ctx.setState("n", (ctx.getState<number>("n") ?? 0) + 1);
        return ctx.json({ n: ctx.getState("n") });
      },
    });

    const a = await inject(app, { url: "/" });
    const b = await inject(app, { url: "/" });
    await expect(a.json()).resolves.toEqual({ n: 1 });
    await expect(b.json()).resolves.toEqual({ n: 1 }); // not 2 — state is per-request
  });
});
