/**
 * @fileoverview Port of Elysia `test/core/formdata.test.ts` — FormData /
 * multipart body parsing on the interpreted `createApp().handler()` path.
 *
 * `ctx.body.form()` returns a flat record (files collapse to their name);
 * `ctx.body.multipart()` returns an object with duplicate keys accumulated
 * into arrays and real `File` values. Parse failures surface as a structured
 * `ParseError` (400), never a 500 or corrupted data.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

const textFile = (name: string, contents: string, type = "text/plain") =>
  new File([contents], name, { type });

describe("FormData parsing (interpreted path)", () => {
  it("parses a urlencoded body into a flat record via form()", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json(await ctx.body.form())),
      {
        method: "POST",
        url: "/",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "a=1&b=two&c=a%20b",
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ a: "1", b: "two", c: "a b" });
  });

  it("parses a multipart FormData body; files collapse to their name in form()", async () => {
    const form = new FormData();
    form.append("a", "1");
    form.append("file", textFile("x.txt", "hello"));

    const res = await inject(
      app(async (ctx) => ctx.json(await ctx.body.form())),
      {
        method: "POST",
        url: "/",
        body: form,
      },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ a: "1", file: "x.txt" });
  });

  it("multipart() keeps duplicate keys as arrays and File values", async () => {
    const form = new FormData();
    form.append("tags", "a");
    form.append("tags", "b");
    form.append("file", textFile("x.txt", "hello"));

    const res = await inject(
      app(async (ctx) => {
        const mp = await ctx.body.multipart();
        // File is a Blob and does not survive JSON.stringify with its props —
        // map it to a serializable shape to assert the parsed value.
        const file = mp.file as File | undefined;
        return ctx.json({
          tags: mp.tags,
          file: file ? { name: file.name, type: file.type, size: file.size } : null,
        });
      }),
      { method: "POST", url: "/", body: form },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tags: string[];
      file: { name: string; type: string; size: number };
    };
    expect(body.tags).toEqual(["a", "b"]);
    expect(body.file.name).toBe("x.txt");
    expect(body.file.type).toBe("text/plain");
    expect(body.file.size).toBe(5);
  });

  it("exposes a raw multipart body via formData() preserving File metadata", async () => {
    const form = new FormData();
    form.append("file", textFile("data.bin", "\u0000\u0001\u0002", "application/octet-stream"));

    const res = await inject(
      app(async (ctx) => {
        const fd = await ctx.body.formData();
        const file = fd.get("file") as File;
        return ctx.json({
          name: file.name,
          size: file.size,
          bytes: (await file.arrayBuffer()).byteLength,
        });
      }),
      { method: "POST", url: "/", body: form },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: "data.bin", size: 3, bytes: 3 });
  });

  it("treats a malformed JSON body as a 400 ParseError, not a 500", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json({ parsed: await ctx.body.json() })),
      {
        method: "POST",
        url: "/",
        headers: { "content-type": "application/json" },
        body: "{not-json",
      },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "BODY_PARSE_ERROR" });
  });

  it("auto-selects no body for GET (matches createLazyBody semantics)", async () => {
    const res = await inject(
      app(async (ctx) => ctx.json({ hasBody: (await ctx.body()) !== undefined })),
      { url: "/" },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ hasBody: false });
  });

  it("explicit .form() on a bodyless GET is a caller error → 400 (documented divergence)", async () => {
    // The auto-select path (`ctx.body()`) yields no body for GET; explicitly
    // asking `.form()` to parse a body that is not there surfaces a 400. This
    // differs from Elysia (empty record) but is consistent HTTP semantics.
    const res = await inject(
      app(async (ctx) => ctx.json(await ctx.body.form())),
      {
        url: "/",
      },
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: "BODY_PARSE_ERROR" });
  });
});
