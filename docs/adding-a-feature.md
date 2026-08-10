# Adding a Feature

A step-by-step guide for extending flux-core safely. Follow the checklist for
your feature type, keep the one-way dependency rule, and always run the gates.

## Before you start

1. Read [architecture.md](architecture.md) — especially the one-way dependency
   rule and the `ContextUsage` AOT contract.
2. Find the smallest surface that can be tested: the compiler has 82 AST unit
   tests, core has lifecycle/security/features tests, native has a parity
   suite. Add tests alongside your feature.
3. Run `bun run verify` before and after.

---

## A: Add a plugin

Plugins live in `packages/core/src/plugins/` and are thin lifecycle wrappers.

1. Create `packages/core/src/plugins/my-plugin.ts` exporting a factory that
   returns a `FluxPlugin` (or a lifecycle fragment).

   ```ts
   // plugins/ratelimit.ts (existing example)
   export const rateLimit = (opts: RateLimitOptions): FluxPlugin => {
     const bucket = createTokenBucket(opts);
     return {
       name: "rate-limit",
       apply(ctx) {
         ctx.lifecycle.beforeHandle.push(async ({ ctx }) => {
           const ok = await bucket.take(ctx.ip);
           if (!ok) return { ok: false, response: new Response("Too Many Requests", { status: 429 }) };
           return { ok: true, ctx };
         });
       },
     };
   };
   ```

2. Wire the export in `packages/core/src/index.ts` (the public API) and add
   `@fileoverview` JSDoc.
3. Add a test in `packages/core/test/` exercising the plugin through
   `runLifecycle` or `createApp`.
4. If the plugin needs a compiler-visible signal (a `ctx` member, a header),
   follow the `ContextUsage` contract instead (see section E).

## B: Add a hook (lifecycle stage)

Hooks run in one of the named stages in `LifeCycleStore`
(`start` / `request` / `parse` / `transform` / `beforeHandle` / `afterHandle` /
`mapResponse` / `afterResponse` / `trace` / `error` / `stop`).

1. If it's an existing stage: write a `HookFn` and register it, or create a
   macro/factory like `requireAuth` in `core/src/auth.ts`.
2. If you need a **new stage**: add it to `LifeCycleStore` in
   `core/src/types.ts`, extend `PRE_HANDLER_STAGES` / `POST_HANDLER_STAGES` in
   `core/src/lifecycle.ts`, update `EMPTY_LIFECYCLE`, and **bump
   `COMPILER_CACHE_VERSION`** (codegen embeds the lifecycle stages).
3. Halting semantics: a hook that returns a `Response` halts the chain
   (`{ ok: false, response }`); pass-through hooks must return `undefined` or
   `{ ok: true, ctx }`.

## C: Add a route type / helper

`@flux/core/http.ts` defines the schema-first helpers (`get`, `post`, …).

1. Add the method helper mirroring `get`/`post` with the right schema bounds
   (`NoBodyRouteSchemas` for GET/DELETE, `BodyRouteSchemas` for body methods).
2. Keep the signature `fn, schema?` — the route path is inferred from the
   filename by the compiler, never passed here.
3. Add an `expect-type` test asserting the inferred `ctx.params/query/body`.
4. If the handler can return a new response type, update `RouteResult` and the
   compiler's response-type inference (`utils/ast/response.ts`).

## D: Add a native function (accelerated primitive)

1. Implement the pure-TS fallback in `packages/native/src/` (e.g. `hash.ts`).
2. Export both the auto-preferring wrapper and the explicit `*Fallback` from
   `packages/native/src/index.ts` (e.g. `fnv1a64` + `fnv1a64Fallback`).
3. If you also have a Rust implementation, add it to the `castrum` addon and
   declare it in `packages/native/src/vendor/castrum.d.ts`.
4. Add parity vectors to `packages/native/test/native.test.ts` (runs against
   the fallback by default; `FLUX_NATIVE_PATH` switches to the real addon).

## E: Add a `ctx` member (AOT contract)

This is the one that crosses the compiler boundary — follow it precisely.

1. **shared**: add the flag to `ContextUsage` in `packages/shared/src/context-usage.ts`
   (and to `EMPTY_USAGE` / `FULL_USAGE` if it is universally available).
2. **core**: add the member to `FluxContext` in `core/src/context.ts` and
   implement it in `createContext`.
3. **compiler**: add the member name to `USAGE_FLAGS` in
   `utils/ast/usage.ts`; gate the context emission in `codegen.ts` on the flag.
   If the member forces the "full context" (like `cookie`/`loader`), add it to
   the `needsFull` condition.
4. **tests**: `packages/compiler/test/ast.test.ts` (usage detection) +
   `packages/core/test/` (runtime behavior).
5. **bump `COMPILER_CACHE_VERSION`** in `packages/compiler/src/cache.ts`.

## F: Add a compiler pass / artifact

1. Add the phase module under `packages/compiler/src/phases/` and wire it into
   the pipeline entry (`src/index.ts` `buildAsync`) at the correct point.
2. Keep phases **pure and testable**: accept inputs, return outputs, report via
   the `DiagnosticCollector` (FLX_* codes in `src/diagnostics.ts`).
3. If the phase changes emitted code, bump `COMPILER_CACHE_VERSION`.
4. Add tests under `packages/compiler/test/` (fixtures live in `test/fixtures/`).

---

## Quality gates (run before pushing)

```sh
bun run verify          # typecheck + typecheck:cli + lint + test
bun run test:coverage   # tests + coverage thresholds
bun run build && bun run smoke   # AOT compile + boot + assert routes
```

CI (`.github/workflows/ci.yml`) runs all of these on every push/PR.
