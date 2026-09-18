import { describe, expect, it } from "vitest";
import type { IgnexContext } from "../src/http/context";
import { buildFusedChains, runFusedPost, runFusedPre } from "../src/lifecycle/fused";
import { pluginsToLifeCycle } from "../src/lifecycle/plugin";
import { runHooks } from "../src/lifecycle/run";

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

// ============================================================================
// Fused vs runtime parity (Task 1.2, WS1).
//
// The SAME plugin set driven through BOTH machinery — the fused runners
// (fused.ts) and the runtime `pluginsToLifeCycle` + `runHooks` (plugin.ts /
// run.ts) — must agree on ctx identity, halt occurrence, and response
// identity/status. The runtime is the authority: deployed compiled servers
// fall back to it, so the fused path must be cheaper, never different.
// ============================================================================

describe("fused vs runtime parity", () => {
  // Minimal PromiseLike whose `then` returns a real Promise — the shape the
  // runtime's plugin containers require (they chain `.then` off the result).
  const thenableOf = (value: unknown): PromiseLike<unknown> => ({
    // eslint-disable-next-line unicorn/no-thenable
    // biome-ignore lint/suspicious/noThenProperty: deliberate PromiseLike fixture — proves the fused runners await any thenable like the runtime
    then(resolve: (v: unknown) => unknown) {
      return Promise.resolve(value).then(resolve);
    },
  });

  describe("sync plugin set", () => {
    const syncPlugins = [
      { name: "cors", onRequest: (c: IgnexContext) => c, onResponse: () => undefined },
      { name: "guard", onRequest: () => undefined },
      { name: "sec", onRequest: () => undefined, onResponse: (_c: IgnexContext, r: Response) => r },
    ];

    it("pre chain: fused result equals pluginsToLifeCycle + runHooks", async () => {
      const { preParse } = buildFusedChains(syncPlugins);
      const runtimePre = [...(pluginsToLifeCycle(syncPlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      // `cors` returns the ctx it received, the rest pass through — the base
      // ctx flows through both machinery by identity, no halt on either side.
      expect(fused.ctx).toBe(runtime.ctx);
      expect(fused.ctx).toBe(base);
      expect(fused.response).toBe(runtime.response);
      expect(fused.response).toBeUndefined();
    });

    it("post chain: fused result equals the composed afterHandle hook", async () => {
      const { post } = buildFusedChains(syncPlugins);
      const after = pluginsToLifeCycle(syncPlugins).afterHandle ?? [];
      const base = ctx();
      const res = new Response("hello");

      const fused = await runFusedPost(post, base, res);
      const runtime = await runHooks(after, base, res);
      // `sec` returns the response it received, `cors` passes through — the
      // base response survives both chains by identity, ctx unchanged.
      expect(fused.ctx).toBe(runtime.ctx);
      expect(fused.ctx).toBe(base);
      expect(fused.response).toBe(res);
      expect(runtime.response).toBe(res);
      expect((fused.response as Response).status).toBe((runtime.response as Response).status);
    });

    it("flattens nested plugin bundles exactly like the runtime", async () => {
      const innerCtx = { name: "inner-ctx" } as unknown as IgnexContext;
      const nested = [
        { name: "outer", onRequest: () => undefined },
        [{ name: "inner", onRequest: () => innerCtx }],
      ];

      const { preParse } = buildFusedChains(nested);
      const runtimePre = [...(pluginsToLifeCycle(nested).request ?? [])];
      expect(preParse).toHaveLength(runtimePre.length); // the bundle is descended

      const base = ctx();
      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      expect(fused.ctx).toBe(runtime.ctx);
      expect(fused.ctx).toBe(innerCtx);
    });
  });

  describe("async plugin set", () => {
    it("pre chain: ctx replacement identity + predecessor threading agree", async () => {
      const A = { name: "A" } as unknown as IgnexContext;
      const B = { name: "B" } as unknown as IgnexContext;
      const C = { name: "C" } as unknown as IgnexContext;
      const seen: IgnexContext[] = [];
      const asyncPlugins = [
        {
          name: "p1",
          onRequest: (c: IgnexContext) => {
            seen.push(c);
            return A;
          },
        },
        {
          name: "p2",
          onRequest: async (c: IgnexContext) => {
            seen.push(c);
            return B;
          },
        },
        {
          name: "p3",
          onRequest: (c: IgnexContext) => {
            seen.push(c);
            return C;
          },
        },
      ];

      const { preParse } = buildFusedChains(asyncPlugins);
      const runtimePre = [...(pluginsToLifeCycle(asyncPlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const seenFused = seen.splice(0);
      const runtime = await runHooks(runtimePre, base);
      const seenRuntime = seen.splice(0);

      // Both machinery handed each hook the same predecessor ctx.
      expect(seenFused[0]).toBe(base);
      expect(seenFused[1]).toBe(A);
      expect(seenFused[2]).toBe(B);
      expect(seenRuntime).toEqual(seenFused);
      expect(fused.ctx).toBe(C);
      expect(runtime.ctx).toBe(C);
      expect(fused.response).toBe(runtime.response);
      expect(fused.response).toBeUndefined();
    });

    it("pre chain: a non-Promise thenable mid-chain is awaited (runtime parity)", async () => {
      const C = { name: "C" } as unknown as IgnexContext;
      const thenablePlugins = [
        { name: "p1", onRequest: async () => C }, // a real Promise seeds the continuation
        { name: "t2", onRequest: () => thenableOf(C) }, // thenable runs inside the continuation
        { name: "t3", onRequest: () => undefined },
      ];

      const { preParse } = buildFusedChains(thenablePlugins);
      const runtimePre = [...(pluginsToLifeCycle(thenablePlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      expect(fused.ctx).toBe(C);
      expect(runtime.ctx).toBe(C);
      expect(fused.response).toBe(runtime.response);
      expect(fused.response).toBeUndefined();
    });

    it("pre chain: thenable resolving falsy passes through", async () => {
      const D = { name: "D" } as unknown as IgnexContext;
      const asyncPlugins = [
        { name: "t1", onRequest: () => D },
        { name: "t2", onRequest: () => thenableOf(undefined) }, // async no-op via thenable
      ];

      const { preParse } = buildFusedChains(asyncPlugins);
      const runtimePre = [...(pluginsToLifeCycle(asyncPlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      expect(fused.ctx).toBe(D);
      expect(runtime.ctx).toBe(D);
    });

    it("post chain: replacement response body + predecessor threading agree", async () => {
      const seen: Response[] = [];
      const postPlugins = [
        {
          name: "q2",
          onResponse: (_c: IgnexContext, r: Response) => {
            seen.push(r);
            return new Response("q1");
          },
        },
        {
          name: "q1",
          onResponse: (_c: IgnexContext, r: Response) => {
            seen.push(r);
            return thenableOf(undefined);
          },
        },
      ];

      const { post } = buildFusedChains(postPlugins);
      const after = pluginsToLifeCycle(postPlugins).afterHandle ?? [];
      const base = ctx();
      const res = new Response("base");

      const fused = await runFusedPost(post, base, res);
      const seenFused = seen.splice(0);
      const runtime = await runHooks(after, base, res);
      const seenRuntime = seen.splice(0);

      // onResponse runs in reverse registration order: q1 (thenable pass-
      // through) first, then q2, which replaces with a fresh Response.
      expect(seenFused[0]).toBe(res);
      expect(seenFused[1]).toBe(res);
      expect(seenRuntime).toEqual(seenFused);
      expect(fused.ctx).toBe(base);
      expect(runtime.ctx).toBe(base);
      expect((fused.response as Response).status).toBe((runtime.response as Response).status);
      expect(await (fused.response as Response).text()).toBe("q1");
      expect(await (runtime.response as Response).text()).toBe("q1");
    });

    it("post chain: a thenable REPLACING the response is awaited (runtime parity)", async () => {
      const postPlugins = [
        // runs LAST (reverse order): replaces the response via a thenable
        {
          name: "a",
          onResponse: (_c: IgnexContext, _r: Response) => thenableOf(new Response("from-a")),
        },
        // runs FIRST: pass-through
        { name: "b", onResponse: (_c: IgnexContext, _r: Response) => undefined },
      ];

      const { post } = buildFusedChains(postPlugins);
      const after = pluginsToLifeCycle(postPlugins).afterHandle ?? [];
      const base = ctx();
      const res = new Response("base");

      const fused = await runFusedPost(post, base, res);
      const runtime = await runHooks(after, base, res);
      expect(await (fused.response as Response).text()).toBe("from-a");
      expect(await (runtime.response as Response).text()).toBe("from-a");
      expect((fused.response as Response).status).toBe((runtime.response as Response).status);
    });
  });

  describe("halting plugin set", () => {
    it("sync halt: response identity + pre-halt ctx agree", async () => {
      const A = { name: "A" } as unknown as IgnexContext;
      const halt = new Response("denied", { status: 403 });
      const haltingPlugins = [
        { name: "auth", onRequest: () => A },
        { name: "guard", onRequest: () => halt },
        { name: "never", onRequest: () => ({ name: "never-ran" }) as unknown as IgnexContext },
      ];

      const { preParse } = buildFusedChains(haltingPlugins);
      const runtimePre = [...(pluginsToLifeCycle(haltingPlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      expect(fused.ctx).toBe(A); // the ctx the guard received — halt carries no halt-ctx
      expect(runtime.ctx).toBe(A);
      expect(fused.response).toBe(halt); // the very halt object, both sides
      expect(runtime.response).toBe(halt);
      expect((fused.response as Response).status).toBe(403);
      expect((runtime.response as Response).status).toBe(403);
    });

    it("async halt (Promise + thenable): response identity + pre-halt ctx agree", async () => {
      const A = { name: "A" } as unknown as IgnexContext;
      const halt = new Response("async-denied", { status: 401 });
      const halt2 = new Response("thenable-denied", { status: 418 });
      const haltPlugins = [
        { name: "auth", onRequest: () => A },
        { name: "guard", onRequest: async () => halt },
      ];
      const thenableFirst = [{ name: "tg", onRequest: () => thenableOf(halt2) }];

      const { preParse } = buildFusedChains(haltPlugins);
      const runtimePre = [...(pluginsToLifeCycle(haltPlugins).request ?? [])];
      const base = ctx();

      const fused = await runFusedPre(preParse, base);
      const runtime = await runHooks(runtimePre, base);
      expect(fused.ctx).toBe(A); // pre-halt ctx survives the awaited halt both ways
      expect(runtime.ctx).toBe(A);
      expect(fused.response).toBe(halt);
      expect(runtime.response).toBe(halt);
      expect((fused.response as Response).status).toBe(401);

      // A thenable halting FIRST in the chain: pre-halt ctx is the base ctx.
      const fusedFirst = await runFusedPre(buildFusedChains(thenableFirst).preParse, base);
      const runtimeFirst = await runHooks(pluginsToLifeCycle(thenableFirst).request ?? [], base);
      expect(fusedFirst.response).toBe(halt2);
      expect(runtimeFirst.response).toBe(halt2);
      expect(fusedFirst.ctx).toBe(base);
      expect(runtimeFirst.ctx).toBe(base);
    });
  });
});
