/**
 * @fileoverview Unit tests for the request-framing conflict guard
 * (`framing-guard.ts`).
 *
 * HTTP request smuggling setup: when the parser trusts one framing signal and
 * a downstream proxy trusts another, an attacker desynchronizes the two.
 * The classic vectors are CL.TE (both `content-length` and
 * `transfer-encoding` present) and TE.CL (a non-chunked/duplicate
 * `transfer-encoding`). Bun enforces one framing at the socket, but a guard
 * at the framework boundary is the belt-and-suspenders an enterprise server
 * wants behind reverse proxies.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { framingConflict, hasConflictingFraming } from "../src/http/framing-guard";
import { inject } from "./helpers/inject";

const headers = (init: Record<string, string>): Headers => new Headers(init);

describe("framingConflict — benign requests", () => {
  it("returns null for a plain content-length body", () => {
    expect(
      framingConflict(headers({ "content-length": "10", "content-type": "application/json" })),
    ).toBeNull();
  });

  it("returns null for a chunked transfer-encoding alone", () => {
    expect(framingConflict(headers({ "transfer-encoding": "chunked" }))).toBeNull();
  });

  it("returns null with no framing headers (zero-length body)", () => {
    expect(framingConflict(headers({ accept: "application/json" }))).toBeNull();
  });

  it("is case-insensitive for both header names and values", () => {
    expect(
      framingConflict(headers({ "Content-Length": "3", "Transfer-Encoding": "Chunked" })),
    ).toBeDefined();
    expect(framingConflict(headers({ "transfer-encoding": "CHUNKED" }))).toBeNull();
  });
});

describe("framingConflict — smuggling setups", () => {
  it("flags content-length + transfer-encoding together (CL.TE)", () => {
    const reason = framingConflict(
      headers({ "content-length": "10", "transfer-encoding": "chunked" }),
    );
    expect(reason).toContain("both");
  });

  it("flags duplicate content-length headers with differing values", () => {
    const h = new Headers();
    h.append("content-length", "5");
    h.append("content-length", "6");
    const reason = framingConflict(h);
    expect(reason).toContain("content-length");
  });

  it("flags duplicate content-length headers with equal values (still ambiguous)", () => {
    const h = new Headers();
    h.append("content-length", "5");
    h.append("content-length", "5");
    expect(framingConflict(h)).toContain("content-length");
  });

  it("flags a non-chunked transfer-encoding (TE.CL / TE.GZIP vectors)", () => {
    const reason = framingConflict(headers({ "transfer-encoding": "gzip" }));
    expect(reason).toContain("chunked");
  });

  it("flags a multi-value transfer-encoding list that is not exactly chunked", () => {
    const reason = framingConflict(headers({ "transfer-encoding": "chunked, gzip" }));
    expect(reason).toContain("chunked");
  });

  it("flags an invalid transfer-encoding value", () => {
    const reason = framingConflict(headers({ "transfer-encoding": "identity" }));
    expect(reason).toContain("chunked");
  });

  it("flags a negative or non-numeric content-length", () => {
    const reason = framingConflict(headers({ "content-length": "-5" }));
    expect(reason).toContain("content-length");
  });
});

describe("hasConflictingFraming convenience", () => {
  it("is true exactly when framingConflict returns a reason", () => {
    expect(
      hasConflictingFraming(headers({ "content-length": "5", "transfer-encoding": "chunked" })),
    ).toBe(true);
    expect(hasConflictingFraming(headers({ "content-length": "5" }))).toBe(false);
  });
});

describe("integration — interpreted request path", () => {
  it("rejects a CL.TE smuggling setup with 400 at the body boundary", async () => {
    const app = createApp({
      handler: async (ctx) => ctx.json({ body: await ctx.body.text() }),
    });
    const res = await inject(app, {
      method: "POST",
      url: "/",
      headers: { "content-length": "5", "transfer-encoding": "chunked" },
      body: "hello",
    });
    expect(res.status).toBe(400);
  });

  it("still parses a normal content-length body (no regression)", async () => {
    const app = createApp({
      handler: async (ctx) => ctx.json({ body: await ctx.body.text() }),
    });
    const res = await inject(app, {
      method: "POST",
      url: "/",
      headers: { "content-length": "5", "content-type": "text/plain" },
      body: "hello",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ body: "hello" });
  });
});
