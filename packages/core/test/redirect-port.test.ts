/**
 * @fileoverview Port of Elysia `test/core/redirect.test.ts` +
 * `test/response/redirect.test.ts` — redirect handling on the interpreted
 * `createApp().handler()` path.
 *
 * `ctx.redirect(url, status?)` defaults to 302 and honours explicit
 * 301/303/307/308. Redirecting via `ctx.set.redirect` (the accumulated
 * response channel) is applied by `applySet` and must produce a Location
 * header without clobbering an in-progress body.
 */

import { createApp } from "@ignex/core";
import { describe, expect, it } from "vitest";
import { inject } from "./helpers/inject";

const app = (handler: Parameters<typeof createApp>[0]["handler"]) => createApp({ handler });

describe("redirect (interpreted path)", () => {
  it("redirects without an explicit status (default 302)", async () => {
    const res = await inject(
      app((ctx) => ctx.redirect("/hello")),
      { url: "/" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/hello");
  });

  it.each([301, 303, 307, 308])("redirects with an explicit %i status", async (status) => {
    const res = await inject(
      app((ctx) => ctx.redirect("/hello", status as 301 | 303 | 307 | 308)),
      {
        url: "/",
      },
    );

    expect(res.status).toBe(status);
    expect(res.headers.get("location")).toBe("/hello");
  });

  it("keeps a relative Location value verbatim", async () => {
    const res = await inject(
      app((ctx) => ctx.redirect("login")),
      { url: "/" },
    );

    expect(res.headers.get("location")).toBe("login");
  });

  it("applies ctx.set.redirect through applySet", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.redirect = "/login";
        return ctx.text("moved");
      }),
      { url: "/" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");
  });

  it("applies ctx.set.redirect with an explicit status", async () => {
    const res = await inject(
      app((ctx) => {
        ctx.set.status = 308;
        ctx.set.redirect = "/home";
        return ctx.text("moved");
      }),
      { url: "/" },
    );

    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("/home");
  });
});

describe("redirect open-redirect guard (interpreted path)", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "//evil.com/phish",
    "///evil.com",
    "\\\\evil.com\\path",
    "http:evil.com",
  ])("rejects unsafe target %j with 400", async (target) => {
    const res = await inject(
      app((ctx) => ctx.redirect(target)),
      { url: "/" },
    );

    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("UNSAFE_REDIRECT");
  });

  it("still permits absolute http(s) targets", async () => {
    const res = await inject(
      app((ctx) => ctx.redirect("https://example.com/login")),
      { url: "/" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://example.com/login");
  });

  it("honours allowExternal for protocol-relative targets", async () => {
    const res = await inject(
      app((ctx) => ctx.redirect("//cdn.example.com/a", undefined, { allowExternal: true })),
      { url: "/" },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("//cdn.example.com/a");
  });
});
