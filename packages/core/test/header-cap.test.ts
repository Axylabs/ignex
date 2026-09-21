/**
 * @fileoverview Tests for the advisory header-bomb cap (`maxHeaderBytes`).
 *
 * Bun enforces its own header limits at the socket, but a server behind a
 * reverse proxy or CDN sometimes takes a request whose headers are already
 * materialized (a proxy header-bomb). `maxHeaderBytes` gives the framework an
 * opt-in defense-in-depth tally: reject with 431 before any handler runs.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { totalHeaderBytes } from "../src/http/header-cap";
import { inject } from "./helpers/inject";

describe("totalHeaderBytes — pure tally", () => {
  it("counts name + value bytes with CRLF framing overhead per pair", () => {
    const h = new Headers({ "x-a": "hello" });
    // "x-a" (3) + ": " (2) + "hello" (5) + CRLF (2) = 12
    expect(totalHeaderBytes(h)).toBe(3 + 2 + 5 + 2);
  });

  it("counts multiple headers and duplicates", () => {
    const h = new Headers();
    h.append("x-a", "1");
    h.append("x-a", "2");
    h.append("x-b", "longer-value");
    const expected =
      [4, 2, 1, 2].reduce((a, b) => a + b, 0) + [4, 2, 13, 2].reduce((a, b) => a + b, 0);
    expect(totalHeaderBytes(h)).toBe(expected);
  });

  it("is zero for an empty header set", () => {
    expect(totalHeaderBytes(new Headers())).toBe(0);
  });
});

describe("maxHeaderBytes — interpreted request path", () => {
  it("without maxHeaderBytes, oversized headers pass through (no cap by default)", async () => {
    let ran = false;
    const app = createApp({
      handler: () => {
        ran = true;
        return new Response("ok");
      },
    });
    const res = await inject(app, {
      url: "/",
      headers: { "x-bomb": "a".repeat(2048) },
    });
    expect(res.status).toBe(200);
    expect(ran).toBe(true);
  });

  it("with maxHeaderBytes set, oversized headers get 431 and the handler never runs", async () => {
    let ran = false;
    const app = createApp({
      maxHeaderBytes: 256,
      handler: () => {
        ran = true;
        return new Response("ok");
      },
    });
    const res = await inject(app, {
      url: "/",
      headers: { "x-bomb": "a".repeat(2048) },
    });
    expect(res.status).toBe(431);
    expect(ran).toBe(false);
  });

  it("with maxHeaderBytes set, a small header set passes untouched", async () => {
    const app = createApp({
      maxHeaderBytes: 256,
      handler: (ctx) => ctx.json({ got: ctx.headers.get("x-small") }),
    });
    const res = await inject(app, { url: "/", headers: { "x-small": "ok" } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ got: "ok" });
  });

  it("rejects with a machine-readable code", async () => {
    const app = createApp({
      maxHeaderBytes: 64,
      handler: () => new Response("ok"),
    });
    const res = await inject(app, { url: "/", headers: { "x-bomb": "b".repeat(512) } });
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("HEADER_TOO_LARGE");
  });
});
