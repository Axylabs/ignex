# Perf Levers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the compiled framework's per-request dispatch machinery (lifecycle fusion), land the public declarative plugin-context API, and add a resource-efficiency pass — each lever verified by the repo's own benches.

**Architecture:** The compiled artifact already boots the app-config plugin OBJECTS at runtime (`__appPlugins`). Instead of dispatching every request through `runHooks(__preParseStages, ctx)` (stage-array walk + HookContainer wrappers that synthesize a `{ ctx }` result object per hook), the artifact composes **direct hook-fn chains at boot** and runs them with small fused runners that interpret the plugin's ACTUAL return (`Response` | ctx | `undefined` | Promise) — no synthesized result objects. A boot-time structural gate (chain-length vs runtime stage counts) falls back to `runHooks` on any mismatch, so semantics can never drift. A new optional `IgnexPlugin.contextUsage` declaration (mirrored by a statically-read module export) lets user plugins unlock the existing usage-specialized context tier.

**Tech Stack:** Bun 1.4+, TypeScript, vitest, oxlint + Biome, the ignex AOT compiler (`packages/compiler`), `@ignex/core` runtime, castrum native layer (untouched by this plan except the WS3 audit).

**Spec:** `docs/superpowers/specs/2026-09-18-perf-levers-design.md`

## Global Constraints

- **Measure, never assume** (RULES.md): every performance claim is backed by `bench:compare:cpu` (head-to-head per `docs/perf-methodology.md` §6; cross-run deltas below ~1µs are not trustworthy) or the hotpath bench. No change ships on "looks faster".
- **Semantics parity is a gate**: `verify:perf` (contract), `verify:aot:rbac`, `smoke` + `smoke:fallback` (`IGNEX_NATIVE=off`), `lifecycle.test.ts`. The fused path and the `runHooks` path must behave identically for the same plugin set.
- **Cache versions**: any generated-code output change bumps `COMPILER_CACHE_VERSION` (`packages/compiler/src/cache.ts`) and — only if module resolution changes — `MODULES_CACHE_VERSION` (`frontend/persist.ts`). Clear `dist/` before every A/B bench (§7.4).
- **No classes on public surfaces**: the new API is a plain readonly property.
- **Docs discipline**: docs must match code; `jsdoc:check:strict`; CHANGELOG `[Unreleased]` entries flow per milestone; `bun run gen:ai-map` after doc-adjacent changes.
- **Do not disturb in-flight work**: the working tree carries uncommitted changes (cache response-policy, debug panels, native http). Perf commits stage ONLY the plan's own files.
- Gates per milestone (run at its end): `bun run verify:quick`, `bunx vitest run packages/core/test packages/compiler/test`, `bun run verify:perf`, `bun run smoke` + `bun run smoke:fallback`, `bun run check:dead`.

---

## Milestone 0 — Re-baseline (WS0)

### Task 0.1: Re-measure the current artifact

**Files:**
- Modify: `docs/perf-methodology.md` §4 and §7.1/7.2 (today's numbers)

**Interfaces:**
- Produces: the fresh `ignus-aot/bun` CPU-per-request ratio and hotpath numbers that every later milestone's before/after reads against.

- [ ] **Step 1: Record the machine state**

Run: `bun run bench:compare:cpu` (all participants, 3×8s, medians)
Expected: printed medians per participant + the `ignus-aot/bun` ratio. Save the output to `/tmp/perf-ws0-compare.txt`.

- [ ] **Step 2: Record server throughput + hotpath numbers**

Run: `bun run bench:server` and `bun scripts/bench-hotpath.ts` (that script exists and was recently modified — check `package.json` for the exact script name first: `grep '"bench:hotpath"\|bench-hotpath' package.json`)
Expected: rps + per-helper medians. Save to `/tmp/perf-ws0-server.txt`.

- [ ] **Step 3: Function/allocation count per request**

Run: build the app (`bun run build` in `packages/app` or root `bun run build`), then start `packages/app/dist/__server.js` under the comparison-bench load generator (`bun run bench:compare:cpu`'s `cpu-wrap.ts` pattern) while capturing `bun --cpu-prof --cpu-prof-md`. Count distinct function names on the request path in the trace; note heap-growth per request via a `--expose-gc` probe (`gc()` before, N requests, `gc()` after, `Bun.memoryUsage()` delta / N).
Expected: a function count and an allocs/req estimate for the CURRENT artifact. Record both.

- [ ] **Step 4: Update perf-methodology §4/§7**

Edit `docs/perf-methodology.md`: replace the stale `2026-09-14` baseline line in §7 (`bun` 23.28µs … `ignus-aot` 33.24µs) with today's numbers; add a dated note that the specialized-tier work (09-15 → 09-18) changed the baseline. Add one line to §4 or §7.2 with the function/allocation counts from Step 3.

- [ ] **Step 5: CHANGELOG + commit**

Append to `CHANGELOG.md` `[Unreleased]`: `- perf: re-baselined bench:compare:cpu + hotpath after the specialized-context tier (see perf-methodology §7)`.
Run: `git add docs/perf-methodology.md CHANGELOG.md && git commit -m "docs(perf): re-baseline after the specialized-context tier (WS0)"`

---

## Milestone 1 — Lifecycle fusion (WS1)

### Task 1.1: Core — fused chain builders and runners

**Files:**
- Create: `packages/core/src/lifecycle/fused.ts`
- Modify: the lifecycle barrel that already exports `runHooks` (find it: `grep -rn "runHooks" packages/core/src/lifecycle/*/index.ts packages/core/src/lifecycle/index.ts packages/core/src/index.ts | grep export`), and any index that re-exports `lifecycle/run.ts` symbols.
- Test: `packages/core/test/lifecycle-fused.test.ts`

**Interfaces:**
- Produces:
  - `export interface FusedFn { (ctx: IgnexContext, response?: Response): unknown }`
  - `export interface FusedChains { readonly preParse: readonly FusedFn[]; readonly post: readonly FusedFn[] }`
  - `export interface FusedResult { ctx: IgnexContext; response?: Response }`
  - `export const buildFusedChains(plugins: readonly unknown[]): FusedChains`
  - `export const runFusedPre(fns: readonly FusedFn[], ctx: IgnexContext): FusedResult | Promise<FusedResult>`
  - `export const runFusedPost(fns: readonly FusedFn[], ctx: IgnexContext, response: Response): FusedResult | Promise<FusedResult>`

- [ ] **Step 1: Write the failing test**

Create `packages/core/test/lifecycle-fused.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { IgnexContext } from "../src/http/context";
import { buildFusedChains, runFusedPost, runFusedPre } from "../src/lifecycle/fused";

const ctx = (over: Record<string, unknown> = {}): IgnexContext =>
  ({ req: new Request("http://ignex.local/a"), method: "GET", path: "/a", route: "", params: {}, ...over }) as unknown as IgnexContext;

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
    expect(r1).toEqual({ ctx: replacement, response: undefined }); // halt wins; ctx is pre-halt ctx
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
    const a = { name: "a", onResponse: undefined as never };
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

type FusedResultLike = { ctx: IgnexContext; response?: Response };
```

Adjust the exact expectations to the semantics you implement in Step 3; the structural asserts (identity of direct fns, dev-only skip, matcher wrap, promise seeding, response threading) must all be present.

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/lifecycle-fused.test.ts`
Expected: FAIL — module `src/lifecycle/fused` not found.

- [ ] **Step 3: Implement `fused.ts`**

```ts
/**
 * @fileoverview Fused lifecycle chains — direct plugin-hook dispatch for
 * compiled servers.
 *
 * `runHooks` (./run.ts) must interpret hooks from many sources (plugins,
 * user lifecycle, legacy callable plugins) through HookContainer wrappers
 * that synthesize a `{ ctx }` result object per call. A COMPILED server that
 * has attributed its whole plugin layer statically can instead compose the
 * plugin hooks DIRECTLY at boot (once) and run them with the narrow
 * interpretation this module implements — the plugin contract itself
 * (`Response` | truthy ctx | `undefined` | Promise). Per-request savings:
 * no container wrapper frame, no synthesized result object, no stage-array
 * walk. `buildFusedChains` mirrors `pluginsToLifeCycle`'s filter/pattern/
 * order decisions exactly, so the two chains are equivalent by construction;
 * the emitting server additionally asserts a boot-time count gate and falls
 * back to `runHooks` on any mismatch.
 */

import type { IgnexContext } from "../http/context";
import { createPatternMatcher, type RoutePattern } from "./plugin";

export type FusedFn = (ctx: IgnexContext, response?: Response) => unknown;

export interface FusedChains {
  /** Direct onRequest fns in registration order (pattern-wrapped). */
  readonly preParse: readonly FusedFn[];
  /** Direct onResponse fns in REVERSE registration order (pattern-wrapped). */
  readonly post: readonly FusedFn[];
}

export interface FusedResult {
  ctx: IgnexContext;
  response?: Response;
}

interface PluginLike {
  readonly name: string;
  readonly pattern?: RoutePattern;
  readonly __ignexDevOnly?: boolean;
  readonly onRequest?: FusedFn;
  readonly onResponse?: (ctx: IgnexContext, response: Response) => unknown;
}

const isPluginLike = (v: unknown): v is PluginLike =>
  typeof v === "object" && v !== null && "name" in v;

/**
 * Compose direct plugin-hook chains from the runtime plugin objects.
 * Mirrors `pluginsToLifeCycle` (plugin.ts): dev-only plugins are dropped,
 * unscoped hooks stay direct, scoped hooks are wrapped with their compiled
 * matcher (reading `ctx.path` ONLY for scoped plugins), and onResponse runs
 * in reverse registration order (onion way-out).
 */
export const buildFusedChains = (plugins: readonly unknown[]): FusedChains => {
  const preParse: FusedFn[] = [];
  const post: FusedFn[] = [];
  for (const p of plugins) {
    if (!isPluginLike(p) || p.__ignexDevOnly === true) continue;
    const matcher = p.pattern === undefined ? null : createPatternMatcher(p.pattern);
    const { onRequest, onResponse } = p;
    if (typeof onRequest === "function") {
      preParse.push(matcher === null ? (onRequest as FusedFn) : (ctx) => (matcher(ctx.path) ? (onRequest as FusedFn)(ctx) : undefined));
    }
    if (typeof onResponse === "function") {
      post.push(matcher === null ? (onResponse as FusedFn) : (ctx, res) => (matcher(ctx.path) ? (onResponse as FusedFn)(ctx, res) : undefined));
    }
  }
  post.reverse();
  return { preParse, post };
};

/** Interpret one raw plugin-hook result: halt with a Response or continue with a ctx. */
const settle = (raw: unknown, fallback: IgnexContext): FusedResult => {
  if (raw instanceof Response) return { ctx: fallback, response: raw };
  return { ctx: (raw as IgnexContext) ?? fallback };
};

/**
 * Run the pre-handler plugin chain. Sync-fast: the all-sync path returns a
 * plain `FusedResult`; the FIRST promise result seeds the async continuation
 * for itself and every later fn (exactly one call per plugin, mirroring
 * `runHooks`'s thenable branch).
 */
export const runFusedPre = (
  fns: readonly FusedFn[],
  ctx: IgnexContext,
): FusedResult | Promise<FusedResult> => {
  let current = ctx;
  for (let i = 0; i < fns.length; i++) {
    const r = fns[i]!(current);
    if (r instanceof Promise) {
      return (async () => {
        const out = settle(await r, current);
        return out.response !== undefined ? out : runFusedPreFrom(fns, i + 1, out.ctx);
      })();
    }
    if (r instanceof Response) return { ctx: current, response: r };
    if (r) current = r as IgnexContext;
  }
  return { ctx: current };
};

async function runFusedPreFrom(
  fns: readonly FusedFn[],
  start: number,
  ctx: IgnexContext,
): Promise<FusedResult> {
  let current = ctx;
  for (let i = start; i < fns.length; i++) {
    const r = fns[i]!(current);
    if (r instanceof Promise) {
      const out = settle(await r, current);
      if (out.response !== undefined) return out;
      current = out.ctx;
      continue;
    }
    if (r instanceof Response) return { ctx: current, response: r };
    if (r) current = r as IgnexContext;
  }
  return { ctx: current };
}

/**
 * Run the onResponse chain in the deployed (reverse) fn order. Mirrors
 * `runOnResponseChain` (plugin.ts): each fn receives the current response and
 * may replace it; `undefined` passes through; the first thenable seeds the
 * continuation that defers every later fn.
 */
export const runFusedPost = (
  fns: readonly FusedFn[],
  ctx: IgnexContext,
  response: Response,
): FusedResult | Promise<FusedResult> => {
  let current: Response | undefined = response;
  for (let i = 0; i < fns.length; i++) {
    const r = fns[i]!(ctx, current as Response);
    if (r instanceof Promise) {
      return (async () => {
        const raw = (await r) as Response | undefined;
        const next = raw instanceof Response ? raw : current;
        const out = await runFusedPostFrom(fns, i + 1, ctx, next as Response);
        return out;
      })();
    }
    if (r instanceof Response) current = r;
  }
  return { ctx, response: current as Response };
};

async function runFusedPostFrom(
  fns: readonly FusedFn[],
  start: number,
  ctx: IgnexContext,
  response: Response,
): Promise<FusedResult> {
  let current: Response | undefined = response;
  for (let i = start; i < fns.length; i++) {
    const r = fns[i]!(ctx, current as Response);
    if (r instanceof Promise) {
      const raw = (await r) as Response | undefined;
      if (raw instanceof Response) current = raw;
      continue;
    }
    if (r instanceof Response) current = r;
  }
  return { ctx, response: current as Response };
}
```

Export the module from the same barrel(s) that export `runHooks` (find with the grep in Files; add `export * from "./fused"` or the equivalent named export line).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run packages/core/test/lifecycle-fused.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lifecycle/fused.ts packages/core/test/lifecycle-fused.test.ts <barrel-files>
git commit -m "feat(core): fused lifecycle chains — direct plugin-hook runners (WS1)"
```

### Task 1.2: Core — parity test fused-vs-runtime chain equality

**Files:**
- Test: `packages/core/test/lifecycle-fused.test.ts` (extend)

**Interfaces:**
- Consumes: `buildFusedChains`, `runFusedPre`, `runFusedPost` (Task 1.1), `pluginsToLifeCycle` + `runHooks` + `runLifecycle` from `../src/lifecycle/plugin` / `run`.
- Produces: the regression net proving fused == runtime interpretation for the plugin contract.

- [ ] **Step 1: Write the failing parity test**

Append to `packages/core/test/lifecycle-fused.test.ts`:

```ts
import { pluginsToLifeCycle } from "../src/lifecycle/plugin";
import { runHooks } from "../src/lifecycle/run";

describe("fused vs runtime parity", () => {
  // The same plugin set driven through BOTH machinery must produce identical
  // (ctx identity, halted/response) outcomes, including async and halts.
  const plugins = [
    { name: "cors", onRequest: (c: IgnexContext) => c, onResponse: () => undefined },
    { name: "guard", onRequest: () => undefined },
    { name: "sec", onRequest: () => undefined, onResponse: (c: IgnexContext, r: Response) => r },
  ];

  it("pre chain: fused result equals pluginsToLifeCycle + runHooks", async () => {
    const { preParse } = buildFusedChains(plugins);
    const lc = pluginsToLifeCycle(plugins);
    const runtimePre = [...(lc.request ?? [])];
    const base = ctx();

    const fused = await runFusedPre(preParse, base);
    const runtime = await runHooks(runtimePre, base);
    expect(fused.ctx).toBe(runtime.ctx);
    expect(fused.response).toBe(runtime.response);
  });

  it("post chain: fused result equals the composed onResponse hook", async () => {
    const { post } = buildFusedChains(plugins);
    const lc = pluginsToLifeCycle(plugins);
    const after = lc.afterHandle ?? [];
    const base = ctx();
    const res = new Response("hello");

    const fused = await runFusedPost(post, base, res);
    const runtime = await runHooks(after, base, res);
    expect(fused.ctx).toBe(runtime.ctx);
    expect((fused.response as Response).status).toBe((runtime.response as Response).status);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run packages/core/test/lifecycle-fused.test.ts`
Expected: FAIL (either a real semantic gap in fused.ts — fix it in Step 3 — or a test-shape issue; the point is the net exists and runs).

- [ ] **Step 3: Make it pass**

If the parity test exposes a divergence (e.g. `runHooks`'s `{ ok:false, response }` handling, or a thenable edge), fix `fused.ts` to match. If the only failures are assertion-shape issues, fix the test. The two chains must agree on: ctx identity, halt occurrence, response identity/status, for sync, async, and halting plugin sets. Add an async-plugin case and a halting-plugin case if not already covered.

- [ ] **Step 4: Run the full core lifecycle suite**

Run: `bunx vitest run packages/core/test/lifecycle.test.ts packages/core/test/lifecycle-fused.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/test/lifecycle-fused.test.ts
git commit -m "test(core): fused-vs-runtime chain parity net (WS1)"
```

### Task 1.3: Compiler — emit the fused dispatchers in the artifact header

**Files:**
- Modify: `packages/compiler/src/phases/codegen/header.ts` (after the stage-chain block, lines ~229-244)
- Modify: `packages/compiler/src/cache.ts` (`COMPILER_CACHE_VERSION` bump)
- Test: extend an existing compiler emission test or add `packages/compiler/test/emission-fused.test.ts` (check `packages/compiler/test` for the existing emission-test pattern first — e.g. how `context-members.test.ts` or route-emission tests are structured and reuse their harness)

**Interfaces:**
- Consumes: `state.appConfigPluginUsage`/`state.appConfigUserLifecycle`/`state.appConfigActivePlugins` (`state.ts`), `state.usedCore` (adds `buildFusedChains`, `runFusedPre`, `runFusedPost`).
- Produces: the header constants `__fused`, `__fusedOK`, `__runPreParse`, `__runAfter` (module-scope, const-folded by the JIT), consumed by Task 1.4's lane replacements.

- [ ] **Step 1: Verify the fusion gate data is present**

Run: `grep -n "appConfigPluginUsage\|appConfigUserLifecycle\|appConfigActivePlugins" packages/compiler/src/phases/codegen/state.ts packages/compiler/src/phases/codegen/imports.ts`
Expected: all three fields exist and are set in `imports.ts:141-143` (already confirmed in exploration: `appConfigUserLifecycle`, `appConfigActivePlugins`, `appConfigPluginUsage`).

- [ ] **Step 2: Write the failing emission test**

In the compiler test you chose (following its harness), add a test compiling a fixture app config with `cors()` + `security()` plugins and asserting the emitted entry contains `const __runPreParse` and the string `buildFusedChains(`. Also a second fixture with a user `lifecycle` export asserting the entry STILL declares `__runPreParse` (the dispatcher is emitted unconditionally for hasAppConfig; only its internals differ). Run it and verify it fails (artifact lacks the constant).

- [ ] **Step 3: Emit the dispatcher block in header.ts**

In `stageHeader`, inside the `state.hasAppConfig` branch, AFTER the stage-chain block (after the `__hasTrace` push at line ~244), append:

```ts
// Fused lifecycle dispatchers (WS1): when the whole plugin layer is
// statically attributed AND carries no user lifecycle, the artifact composes
// DIRECT plugin-hook chains at boot and runs them with the narrow fused
// runners (core/lifecycle/fused.ts) instead of walking the HookContainer
// stage arrays — no per-hook synthesized result object, no container
// dispatch. `__fusedOK` is a boot-time STRUCTURAL gate: the fused chain must
// exactly mirror the runtime stage counts (plugins produce only request /
// afterHandle-composed stages; user lifecycle would add containers and trip
// the gate). Any mismatch falls back to `runHooks`, so the emitted lanes
// behave identically either way. The dispatchers are emitted unconditionally
// for hasAppConfig builds so there is ONE emission path.
header.push(`const __fused = buildFusedChains(__appPlugins);
const __fusedOK =
  __fused.preParse.length === __preParseStages.length &&
  __lc.mapResponse.length === 0 &&
  __lc.afterHandle.length === (__fused.post.length > 0 ? 1 : 0);
const __runPreParse = __fusedOK
  ? (ctx) => runFusedPre(__fused.preParse, ctx)
  : (ctx) => runHooks(__preParseStages, ctx);
const __runAfter = __fusedOK
  ? (ctx, response) => runFusedPost(__fused.post, ctx, response)
  : (ctx, response) => runHooks(__lc.afterHandle, ctx, response);`);
state.usedCore.add("buildFusedChains");
state.usedCore.add("runFusedPre");
state.usedCore.add("runFusedPost");
```

- [ ] **Step 4: Bump the compiler cache version**

In `packages/compiler/src/cache.ts`, increment `COMPILER_CACHE_VERSION` (generated-code path changed). Do not touch `MODULES_CACHE_VERSION` (no module-resolution change in this task).

- [ ] **Step 5: Run test to verify it passes + compiler suite**

Run: the emission test, then `bunx vitest run packages/compiler/test`
Expected: PASS (any snapshot-based emission tests that embed the old header layout will need their snapshot regenerated — check for a snapshot update command in the test harness and run it, then review the diff).

- [ ] **Step 6: Commit**

```bash
git add packages/compiler/src/phases/codegen/header.ts packages/compiler/src/cache.ts <compiler-test-files>
git commit -m "feat(compiler): emit fused lifecycle dispatchers with boot-time gate (WS1)"
```

### Task 1.4: Compiler — replace the per-request lanes with the dispatchers

**Files:**
- Modify: `packages/compiler/src/phases/codegen/routes/context.ts` (4 call sites at lines ~227, 245, 363, 371)
- Modify: `packages/compiler/src/phases/codegen/routes/handler.ts` (afterHandle lanes at lines ~113, 209, 286)

**Interfaces:**
- Consumes: `__runPreParse` / `__runAfter` (Task 1.3).
- Produces: routes whose hot lanes are dispatcher calls; `beforeHandle`/`mapResponse`/`afterResponse`/`trace`/error lanes remain `runHooks` and are untouched.

- [ ] **Step 1: Replace the pre-parse call sites in context.ts**

In `routes/context.ts`, replace every emitted `runHooks(__preParseStages, ctx)` with `__runPreParse(ctx)` in the four string literals (both branches of `buildFullContextPrelude` and both branches of `buildSpecializedContext`'s ladder). The surrounding shape (`const __r = …; if (__r instanceof Promise) …; const __globalPre = __r;`) is unchanged — only the callee changes.

- [ ] **Step 2: Replace the afterHandle call sites in handler.ts**

In `routes/handler.ts`, replace every emitted `runHooks(__lc.afterHandle, ctx, response)` (including inside `runTimed("afterHandle", "lifecycle", () => …)`) with `__runAfter(ctx, response)` at the three sites (~lines 113, 209, 286). Leave `beforeHandle`, `mapResponse`, `afterResponse`, `trace`, route-hook, and error lanes as-is.

- [ ] **Step 3: Update/extend emission tests**

Extend the emission test from Task 1.3: assert the emitted route entry no longer contains `runHooks(__preParseStages` and contains `__runPreParse(ctx)`. Run the compiler suite.

- [ ] **Step 4: Smoke both modes**

Run: `bun run smoke` and `bun run smoke:fallback` (compiled app with plugins must serve identical behavior with the fused lanes).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/compiler/src/phases/codegen/routes/context.ts packages/compiler/src/phases/codegen/routes/handler.ts <compiler-test-files>
git commit -m "feat(compiler): route lanes run through the fused lifecycle dispatchers (WS1)"
```

### Task 1.5: Milestone gate — verify + measure + docs

**Files:**
- Modify: `docs/perf-methodology.md` §7 (fusion result + any ruled-out line)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Full verification**

Run: `bun run verify:quick`, `bunx vitest run packages/core/test packages/compiler/test`, `bun run verify:perf`, `bun run check:dead`
Expected: all pass. Fix anything this plan introduced (do not fix pre-existing warnings).

- [ ] **Step 2: A/B measurement**

Run `bun run bench:compare:cpu` now, against the WS0 numbers. Because the change is codegen-shaped, argue the result structurally if it is under the ~1µs resolution limit (§7.4). Also run `bun scripts/bench-hotpath.ts`.
Expected: record before/after; if `ignus-aot/bun` regressed, this milestone is failed — investigate before proceeding (the boot gate must have fallen back everywhere, or a lane was missed; check `__fusedOK` behavior first).

- [ ] **Step 3: Docs + CHANGELOG**

Write the result into `perf-methodology.md` §7 (dated line: fusion on/off numbers, `__fusedOK` gate description, function-count delta vs the WS0 count). Add a `[Unreleased]` CHANGELOG entry: `- perf(compiler): fused lifecycle dispatch — direct plugin-hook chains replace the stage-array walk (gated, falls back to runHooks)`.
Run: `bun run gen:ai-map` if any doc under `docs/` changed.

- [ ] **Step 4: Commit**

```bash
git add docs/perf-methodology.md CHANGELOG.md
git commit -m "docs(perf): WS1 fusion measurement + CHANGELOG"
```

---

## Milestone 2 — Declarative plugin context API (WS2)

### Task 2.1: Core — `IgnexPlugin.contextUsage` field

**Files:**
- Modify: `packages/core/src/lifecycle/plugin.ts` (the `IgnexPlugin` interface, after `contextOptions` ~line 74)
- Test: `packages/core/test/plugin.test.ts` (or the file covering `IgnexPlugin` — find it: `grep -rln "IgnexPlugin" packages/core/test`)

**Interfaces:**
- Consumes: `ContextUsage` type from `@ignex/shared`.
- Produces: `readonly contextUsage?: Readonly<Partial<ContextUsage>>` on `IgnexPlugin` (the JSDoc is the API authority).

- [ ] **Step 1: Write the failing type test**

Add to the plugin test file a type-level assertion (or a docs-linked test) that a plugin object may declare `contextUsage: { headers: true }` and that the field is optional:

```ts
import type { IgnexPlugin } from "../src/lifecycle/plugin";

const declared: IgnexPlugin = { name: "p", contextUsage: { headers: true, req: true } };
const undeclared: IgnexPlugin = { name: "q" };
// @ts-expect-error — unknown members are not part of the declaration contract
const bad: IgnexPlugin = { name: "r", contextUsage: { nope: true } } as never;
expect(declared.name).toBe("p");
expect(undeclared.name).toBe("q");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run <that test file>`
Expected: FAIL — `contextUsage` does not exist on `IgnexPlugin`.

- [ ] **Step 3: Add the field + JSDoc**

In `plugin.ts`, after the `contextOptions` member, add:

```ts
/**
 * The `ctx` members this plugin's hooks read or write.
 *
 * Declaring them lets the COMPILED server run the plugin layer on the
 * usage-specialized context (see `packages/compiler/.../routes/context.ts`)
 * instead of forcing every route to the full context — the declaration is
 * the missing "plugin-API" piece of that optimization.
 *
 * The compiler cannot execute plugin factories, so for compiled builds the
 * same declaration is read STATICALLY from the plugin module (a module-level
 * `export const contextUsage = { ... }`). The module export is the audited,
 * machine-readable form and wins when both exist; this field is the
 * runtime-visible API surface (introspection, interpreted tooling).
 *
 * Optional and opt-in. An UNDECLARED plugin keeps today's behavior: the
 * compiler treats the plugin layer as opaque and every route uses the full
 * context. A declared member the specialized context cannot emit also forces
 * the full context (fail-safe — never a silent `undefined` on the lean
 * tier). Only `true` values are meaningful; a `false`/`undefined` value
 * reads as "not used".
 */
readonly contextUsage?: Readonly<Partial<ContextUsage>>;
```

Add the `ContextUsage` import to `plugin.ts` (`import type { ContextUsage } from "@ignex/shared";`).

- [ ] **Step 4: Run test to verify it passes**

Run: `bunx vitest run <that test file>` and `bun run verify:quick` (jsdoc:check:strict must pass).
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/lifecycle/plugin.ts packages/core/test/plugin.test.ts
git commit -m "feat(core): IgnexPlugin.contextUsage — declared context requirements (WS2)"
```

### Task 2.2: Compiler — statically read a user plugin module's `contextUsage` export

**Files:**
- Create: `packages/compiler/src/phases/analysis/declared-usage.ts`
- Modify: `packages/compiler/src/phases/analysis/internal-plugins.ts` (`resolveGlobalPluginUsage` — or move the merge here and extend it)
- Modify: `packages/compiler/src/phases/analysis/app-config.ts` (call site)
- Test: `packages/compiler/test/declared-usage.test.ts`

**Interfaces:**
- Consumes: `PluginCallInfo { name, source }` (types.ts), the frontend `SourceManager` (`sources.fromSource`) that app-config analysis uses, `INTERNAL_PLUGIN_USAGE`.
- Produces:
  - `export const readDeclaredContextUsage(source: SourceManager, spec: string, fromPath: string): Readonly<ContextUsage> | null` — parses the module `spec` resolves to, finds a statically-parseable `export const contextUsage = { …literal… }`, maps only members in `EMITTED_USAGE_FLAGS`-compatible keys, returns `null` on any non-literal/unparsable/unknown-member declaration.
  - `resolveGlobalPluginUsage` extended: an attributed call whose `source` is NOT internal is still satisfiable when `readDeclaredContextUsage` returns a non-null usage for it.

- [ ] **Step 1: Check the module-resolution helper available in this phase**

Run: `grep -rn "resolveSpecifier\|specifierToPath\|importSourceOf\|toImportPath" packages/compiler/src --include=*.ts | head -30`
Expected to find: `importSourceOf(source, name)` in `phases/analysis/dev-only-plugins.ts:237` already maps a plugin callee to its import SPECIFIER (`PluginCallInfo.source`, e.g. `"./auth"`) — that is the string to resolve. Then find where the compiler turns a specifier into an abs module path / `ModuleInfo` (note `ModuleInfo = SourceFile` at `types.ts:357`; `SourceFile` is declared at `frontend/source-file.ts:25` and parsed via `frontend/source-manager.ts` `fromSource(absPath, relPath, content, diagnostics)`). Reuse that resolution path in the new function — do not invent a new resolver.

- [ ] **Step 2: Write the failing test**

Create `packages/compiler/test/declared-usage.test.ts` following the app-config test harness (fixture modules under a temp dir):

- fixture `declared-plugin.ts`: `export const contextUsage = { headers: true, method: true }; export const plugin = { name: "p", onRequest() {} };`
- fixture `opaque-plugin.ts`: `export const plugin = { name: "q", onRequest() {} };` (no declaration)

Assertions: `readDeclaredContextUsage` returns `{ headers: true, method: true }` for the declared module, `null` for the opaque module, `null` when the export body is not a literal object (e.g. `export const contextUsage = makeUsage()`), and `null` when a member is not a known `ContextUsage` key. Then an integration case: an app config importing `./declared-plugin` and registering `plugin` yields `globalPluginUsage` NON-null (via the extended `resolveGlobalPluginUsage`), while the same config registering `opaque-plugin` yields `null`.

- [ ] **Step 3: Implement `readDeclaredContextUsage`**

Implement per the Interface contract, reusing the resolution found in Step 1. Concrete AST contract: read the resolved module through the `SourceManager` (`fromSource`), walk the parsed `SourceFile`'s export declarations (the `SourceFile` interface at `frontend/source-file.ts:25` exposes `exports`/`imports` — inspect it first) for a statically-initialized `contextUsage` object literal (`export const contextUsage = { key: true, … }`), translating `key: true` entries into `ContextUsage` flags. Return `null` — never a partial usage — on: a non-literal initializer, an unknown member key, a non-`true` value, a missing export, or multiple declarations.

- [ ] **Step 4: Extend `resolveGlobalPluginUsage`**

In `internal-plugins.ts`, extend the merge loop: when `INTERNAL_PLUGIN_SOURCES.has(call.source)` use `INTERNAL_PLUGIN_USAGE[call.name]` as today; otherwise consult `readDeclaredContextUsage(...)` for the call's `source`; either source returning `null` ⇒ whole-layer `{ usage: null }` (opaque). Keep the API conservative: ANY undeclared plugin still forces full context. Adjust the `app-config.ts` call site to pass the `SourceManager` and the app-config module path through.

- [ ] **Step 5: Run tests + compiler suite**

Run: `bunx vitest run packages/compiler/test/declared-usage.test.ts` then `bunx vitest run packages/compiler/test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/compiler/src/phases/analysis/declared-usage.ts packages/compiler/src/phases/analysis/internal-plugins.ts packages/compiler/src/phases/analysis/app-config.ts packages/compiler/test/declared-usage.test.ts
git commit -m "feat(compiler): read user-plugin contextUsage declarations statically (WS2)"
```

### Task 2.3: Milestone gate — end-to-end check + docs

**Files:**
- Modify: `packages/compiler/src/cache.ts` (bump `COMPILER_CACHE_VERSION` if any generated output changed — the analyzer feeds codegen state, so bump)
- Modify: `packages/core/src/lifecycle/plugin.ts` (already updated — verify no flow-through edits), `docs/router.md` (declaration story), `CHANGELOG.md`

- [ ] **Step 1: End-to-end: a user plugin with declaration lands on the specialized tier**

Build a throwaway fixture app (in `/tmp`, following `packages/app` structure) whose `src/app.config.ts` registers `cors()` PLUS a user plugin with an exported `contextUsage` declaration. Compile it (`bun run build` against the fixture) and inspect `dist/__server.js`: the route entry must contain a specialized-context emission (object-literal `ctx = { … }`) rather than `createContext(`. Then remove the declaration, rebuild, and confirm the route returns to `createContext(` (full). Record both artifacts' behavior is identical (same responses).

- [ ] **Step 2: Full verification**

Run: `bun run verify:quick`, `bunx vitest run packages/core/test packages/compiler/test`, `bun run smoke` + `bun run smoke:fallback`, `bun run check:dead`
Expected: all pass.

- [ ] **Step 3: Docs + CHANGELOG**

Add the declaration story to `docs/router.md` (one subsection: "Plugin context declarations" — the field, the module-export form, the fail-safe rule). Add `[Unreleased]`: `- feat(core): IgnexPlugin.contextUsage unlocks the specialized context for user plugins (WS2)`.
Run: `bun run gen:ai-map`.

- [ ] **Step 4: Commit**

```bash
git add packages/compiler/src/cache.ts docs/router.md CHANGELOG.md
git commit -m "docs(core): declarative plugin context — router doc + changelog (WS2)"
```

---

## Milestone 3 — Resource pass (WS3)

### Task 3.1: Allocation-count bench script

**Files:**
- Create: `scripts/bench-allocations.ts`
- Modify: `package.json` (add `"bench:allocations"` script), `docs/perf-methodology.md` §4

- [ ] **Step 1: Write the script**

`scripts/bench-allocations.ts`: builds/loads the compiled `packages/app/dist/__server.js`, forces `gc()` (run Bun with `--expose-gc`), serves N identical requests, forces `gc()` again, and prints heap growth per request (`(after - before) / N` from `Bun.memoryUsage()`), median of 5 rounds, warmup first. Model it on the existing `scripts/bench-hotpath.ts` structure and imports.

- [ ] **Step 2: Run it and record the baseline**

Run: `bun --expose-gc scripts/bench-allocations.ts`
Expected: an allocs/req number. Record it in `docs/perf-methodology.md` §4 next to the WS0 number.

- [ ] **Step 3: Commit**

```bash
git add scripts/bench-allocations.ts package.json docs/perf-methodology.md
git commit -m "feat(bench): per-request allocation-count bench (WS3)"
```

### Task 3.2: FFI-handle lifecycle audit

**Files:**
- Audit: `packages/native/src` (all surfaces), `vendor/castrum.d.ts`
- Modify: `docs/perf-methodology.md` §5 (audit result) and any surface found leaking

- [ ] **Step 1: Enumerate Create/Destroy pairs**

Run: `grep -rn "Create\|Destroy\|_free\|dealloc" packages/native/src --include=*.ts`
For every `*Create`/factory that returns a pointer or handle (validators, negotiators, route instances, metric handles — check `ffi.ts`, `route-wire.ts`, `validator.ts`, `negotiate.ts`, `metrics`), confirm a matching `*Destroy`/free call exists on the paths that hold it. Instances/routes/metrics are named in perf-methodology §5 as the known "hold handles alive from JS" class.

- [ ] **Step 2: Fix what is found (or record the negative)**

For each unmatching pair found: add the missing destroy at the right lifetime boundary (per-surface, smallest change). If nothing is found, record the audit result (date + surfaces checked) in `perf-methodology.md` §5 as a passing audit.

- [ ] **Step 3: Verify native suites**

Run: `bun run verify:native:route` and `bun run verify:native:ffi` (and `bun run test:native` if it exists).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/native/src <changed native files> docs/perf-methodology.md
git commit -m "audit(native): FFI handle Create/Destroy pairing (WS3)"
```

### Task 3.3: RSS-stability probe

**Files:**
- Create: `scripts/check-rss-stability.ts`
- Modify: `package.json` (add `"check:rss"` script)

- [ ] **Step 1: Write the script**

`scripts/check-rss-stability.ts`: spawns the compiled `packages/app/dist/__server.js` (via the `cpu-wrap.ts` spawn pattern so CPU/RSS are attributable), drives it under load (reuse the comparison-bench load generator's O(1)-gate client) for ~3 minutes, samples `process.memoryUsage().rss` of the server every 5s, and exits non-zero if RSS drift from the warmup plateau exceeds a threshold (start with 20% — tune once, document the threshold in the script header). Print the drift curve.

- [ ] **Step 2: Run it against the current artifact**

Run: `bun scripts/check-rss-stability.ts`
Expected: bounded drift reported. Record the result (a line in the script header / perf-methodology §7.3 as a passing check, or a finding if it fails — a failure means an RSS leak exists; investigate with `--expose-gc` + heap captures before touching anything).

- [ ] **Step 3: Commit**

```bash
git add scripts/check-rss-stability.ts package.json
git commit -m "feat(scripts): RSS-stability probe under load (WS3)"
```

### Task 3.4: Task-runtime lazy-spawn verification

**Files:**
- Audit-only: `packages/native/src` task-runtime surface + `docs/perf-methodology.md` §5 note

- [ ] **Step 1: Verify lazy spawn**

Read the task-runtime implementation (find it: `grep -rn "createTaskRuntime\|cores\|threads" packages/native/src --include=*.ts`) and confirm the Rust pool threads are spawned on FIRST op, not at module import (check the castrum side too: `/home/adeel/poc/castrum/rust/` for the task runtime's `spawn`/`lazy` behavior). If threads ARE reserved eagerly at import, note it; do not change the castrum crate from this repo (cross-repo change needs its own decision) — record the finding.

- [ ] **Step 2: Record the finding**

Add one line to `perf-methodology.md` §5 (dated): task runtime thread spawn behavior — verified lazy / reserving, whichever was found.

- [ ] **Step 3: Commit**

```bash
git add docs/perf-methodology.md
git commit -m "docs(perf): task-runtime thread-spawn verification (WS3)"
```

### Task 3.5: Milestone gate + final docs fold

**Files:**
- Modify: `docs/perf-methodology.md` §7 (WS3 results, any new ruled-out line), `CHANGELOG.md`
- Delete: `docs/superpowers/specs/2026-09-18-perf-levers-design.md` and `docs/superpowers/plans/2026-09-18-perf-levers.md` (AGENTS.md: completed plans are not kept — conclusions live in the docs)

- [ ] **Step 1: Full verification**

Run: `bun run verify:quick`, `bunx vitest run packages/core/test packages/compiler/test`, `bun run verify:perf`, `bun run check:dead`, `bun run verify:full` if the milestone changed native or build paths (Task 3.2 did).
Expected: all pass.

- [ ] **Step 2: Final measurement sweep**

Run: `bun run bench:compare:cpu` and `bun --expose-gc scripts/bench-allocations.ts`. Compare against WS0 and WS1 numbers; write the final program result into `perf-methodology.md` §7 (dated): the `ignus-aot/bun` ratio, allocs/req, function count, RSS-check line, plus any NEW ruled-out hypotheses (e.g. if fusion measured a negative, record it with the `__fusedOK` explanation).

- [ ] **Step 3: CHANGELOG + cleanup**

Add any final `[Unreleased]` entries (WS3 resource lines). Then delete the spec and this plan file, and commit the docs fold:
```bash
git rm docs/superpowers/specs/2026-09-18-perf-levers-design.md docs/superpowers/plans/2026-09-18-perf-levers.md
git add docs/perf-methodology.md CHANGELOG.md
git commit -m "docs(perf): WS3 results + final fold — program complete (spec/plan archived in git log)"
```

- [ ] **Step 4: Report**

Summarize for the user: before/after `bench:compare:cpu` ratio, allocs/req before/after, what was ruled out, and every commit hash.