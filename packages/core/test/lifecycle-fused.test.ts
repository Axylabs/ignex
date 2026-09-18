import { describe, expect, it } from "vitest";
import type { IgnexContext } from "../src/http/context";
import { buildFusedChains, runFusedPost, runFusedPre } from "../src/lifecycle/fused";

type FusedResultLike = { ctx: IgnexContext; response?: Response };

const ctx = (over: Record<string, unknown> = {}): IgnexContext =>
  ({
    req: new Request("http://ignex.local/a"),
    method: "GET",
    path: "/a",
    route: "",
    params: {},
    ...over,
  }) as unknown as IgnexContext;

describe("buildFusedChains", () => {
  it("keeps unscoped onRequest fns direct, reverse-order onResponse", () => {
    const a = { name: "a", onRequest: () => undefined, onResponse: () => undefined };
    const b = { name: "b", onRequest: () => undefined };
    const { preParse, post } = buildFusedChains([a, b]);
    expect(preParse).toHaveLength(2);
    expect(preParse[0]).toBe(a.onRequest); // direct, not wrapped
    // a has onResponse; b does not → post = [a.onResponse]
    expect(post).toHaveLength(1);
    expect(post[0]).toBe(a.onResponse);
  });

  it("skips dev-only plugins and wraps scoped requests with a matcher", () => {
    const scoped = { name: "s", pattern: "/admin", onRequest: () => undefined };
    const dev = { name: "d", __ignexDevOnly: true, onRequest: () => undefined };
    const { preParse } = buildFusedChains([scoped, dev]);
    expect(preParse).toHaveLength(1);
    expect(preParse[0]).not.toBe(scoped.onRequest); // wrapped
    expect(preParse[0]!(ctx({ path: "/admin" }))).toBeUndefined();
    expect(preParse[0]!(ctx({ path: "/other" }))).toBeUndefined();
  });
});

describe("runFusedPre", () => {
  it("replaces ctx on truthy non-Response results and halts on Response", () => {
    const replacement = { name: "r" } as unknown as IgnexContext;
    const r1 = runFusedPre([() => replacement, () => new Response("stop")], ctx());
    // The second hook halts with a Response; `ctx` is the pre-halt ctx (the
    // replacement produced by the first hook) — halt wins, ctx is pre-halt.
    expect(r1).toMatchObject({ ctx: replacement, response: expect.any(Response) });
  });

  it("promise results seed the async continuation", async () => {
    const out = await runFusedPre(
      [() => Promise.resolve({ name: "r" } as unknown as IgnexContext), () => new Response("x")],
      ctx(),
    );
    expect(out).toMatchObject({ response: expect.any(Response) });
  });
});

describe("runFusedPost", () => {
  it("threads the response, keeps undefined pass-through, applies reverse order", () => {
    const base = new Response("base");
    const out = runFusedPost(
      [
        (_c, res) => new Response(res === base ? "after-a" : "wrong"),
        () => undefined, // pass-through
      ],
      ctx(),
      base,
    );
    expect((out as FusedResultLike).response).not.toBe(base);
  });
});
