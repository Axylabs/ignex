/**
 * @fileoverview Port of Elysia `test/regression/security.test.ts` (CRLF /
 * header-injection part) + `test/core/sanitize.test.ts` — input sanitization
 * on the interpreted path.
 *
 * A reflected CRLF header value must never create an injected header nor
 * crash the request: `applySet` strips CR/LF/NUL from header values before
 * they reach the wire (matching Elysia's "drops a reflected CRLF header"
 * behavior), so a hostile `?v=foo%0d%0ax-injected: pwned` yields a healthy
 * 200 with a scrubbed value.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

const CRLF = "foo\r\nx-injected: pwned";

describe("CRLF header injection (interpreted path)", () => {
  it("never creates an injected header from a reflected CRLF value", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-echo"] = ctx.query.get("v") ?? "";
        return ctx.text("ok");
      }),
      { url: "/reflect?v=" + encodeURIComponent(CRLF) },
    );

    expect(res.status).toBe(200);
    expect(res.headers.has("x-injected")).toBe(false);
    await expect(res.text()).resolves.toBe("ok");
  });

  it("strips CR/LF/NUL so the scrubbed value stays on the reflected header", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-echo"] = ctx.query.get("v") ?? "";
        return ctx.text("ok");
      }),
      { url: "/reflect?v=" + encodeURIComponent(CRLF) },
    );

    // The control chars are dropped; the rest of the text stays a single
    // (harmless) value on the one header — nothing is smuggled into a new one.
    expect(res.headers.get("x-echo")).toBe("foox-injected: pwned");
  });

  it("strips NUL bytes and bare LF from reflected values", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-echo"] = ctx.query.get("v") ?? "";
        return ctx.text("ok");
      }),
      { url: "/reflect?v=" + encodeURIComponent("a\u0000b\nc") },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("x-echo")).toBe("abc");
  });

  it("leaves a clean reflected value untouched", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-echo"] = ctx.query.get("v") ?? "";
        return ctx.text("ok");
      }),
      { url: "/reflect?v=" + encodeURIComponent("hello world") },
    );

    expect(res.headers.get("x-echo")).toBe("hello world");
  });
});

describe("input sanitization", () => {
  it("applies array header values sanitized per entry", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.headers["x-list"] = ["a", "b\r\nc"];
        return ctx.text("ok");
      }),
      { url: "/" },
    );

    expect(res.headers.get("x-list")).toBe("a, bc");
  });
});
