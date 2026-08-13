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
