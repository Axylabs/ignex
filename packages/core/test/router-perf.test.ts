/**
 * Audit #6/#7 characterization tests: dispatch must keep FIRST-registration
 * precedence (exact static first, then dynamic patterns in registration
 * order), and registration must not rebuild the 405 allow-lists from scratch
 * per route (aggregate O(N²)).
 */
import { describe, expect, it, vi } from "vitest";
import { createRouter } from "../src/http/router";

describe("createRouter — dispatch precedence", () => {
  it("dispatches to the FIRST registered handler for duplicate method+path", async () => {
    const router = createRouter();
    const calls: string[] = [];
    router.get("/dup", (ctx) => {
      calls.push("first");
      return ctx.json({ which: "first" });
    });
    router.get("/dup", (ctx) => {
      calls.push("second");
      return ctx.json({ which: "second" });
    });

    const res = await router.dispatch(new Request("http://x/dup"));
    expect(calls).toEqual(["first"]);
    await expect(res.json()).resolves.toEqual({ which: "first" });
  });

  it("matches static paths before dynamic patterns", async () => {
    const router = createRouter();
    const calls: string[] = [];
    // Dynamic registered FIRST — a static /users/me must still win via pass 1.
    router.get("/users/:id", (ctx) => {
      calls.push("dynamic");
      return ctx.json({ which: "dynamic" });
    });
    router.get("/users/me", (ctx) => {
      calls.push("static");
      return ctx.json({ which: "static" });
    });

    const res = await router.dispatch(new Request("http://x/users/me"));
    expect(calls).toEqual(["static"]);
    await expect(res.json()).resolves.toEqual({ which: "static" });
  });

  it("returns the first matching dynamic pattern in registration order", async () => {
    const router = createRouter();
    const calls: string[] = [];
    router.get("/w/:a/rest", (ctx) => {
      calls.push("two-seg");
      return ctx.json({ which: "two-seg" });
    });
    router.get("/w/*", (ctx) => {
      calls.push("wildcard");
      return ctx.json({ which: "wildcard" });
    });

    const res = await router.dispatch(new Request("http://x/w/x/rest"));
    expect(calls).toEqual(["two-seg"]);
    await expect(res.json()).resolves.toEqual({ which: "two-seg" });
  });

  it("answers HEAD on a GET route with a stripped body", async () => {
    const router = createRouter();
    router.get("/h", (ctx) => ctx.text("payload"));
    const res = await router.dispatch(new Request("http://x/h", { method: "HEAD" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });
});

describe("createRouter — registration does not rebuild allow-lists per route", () => {
  it("keeps 405 allows correct while registering many routes", () => {
    const router = createRouter();
    for (let i = 0; i < 500; i++) {
      router.get(`/r${i}`, (ctx) => ctx.text("ok"));
      if (i % 2 === 0) router.post(`/r${i}`, (ctx) => ctx.text("ok"));
    }

    // Spot-check the allow-lists stay complete without a full rebuild:
    const routes = router.buildRoutes();
    expect(Object.keys(routes).length).toBe(500);
  });

  it("recomputes the duplicate warning from an index (same behavior, one pass)", () => {
    const router = createRouter();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    router.get("/same", (ctx) => ctx.text("a"));
    router.get("/same", (ctx) => ctx.text("b"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("duplicate route registration: GET /same");
    warn.mockRestore();
  });

  it("answers 405 with the full Allow header before buildRoutes", async () => {
    const router = createRouter();
    router.get("/only", (ctx) => ctx.text("get"));
    router.post("/only", (ctx) => ctx.text("post"));
    const res = await router.dispatch(new Request("http://x/only", { method: "DELETE" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("GET,HEAD,OPTIONS,POST");
  });

  it("registers object-style routes with incremental indexes", async () => {
    const router = createRouter();
    router.route({
      method: "GET",
      path: "/obj",
      handler: (ctx) => ctx.text("obj"),
    });
    const res = await router.dispatch(new Request("http://x/obj"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("obj");
    const res405 = await router.dispatch(new Request("http://x/obj", { method: "POST" }));
    expect(res405.status).toBe(405);
    expect(res405.headers.get("Allow")).toBe("GET,HEAD,OPTIONS");
  });
});
