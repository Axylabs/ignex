# Adding a Feature

A step-by-step guide for extending ignex safely. Follow the checklist for
your feature type, keep the one-way dependency rule, and always run the gates.

## Before you start

1. Read [architecture.md](architecture.md) — especially the one-way dependency
   rule and the `ContextUsage` AOT contract.
2. Find the smallest surface that can be tested: the compiler has AST unit
   tests, core has lifecycle/security/features tests, native has a parity
   suite. Add tests alongside your feature.
3. Run `bun run verify` before and after.

---

## A: Add a plugin

Plugins live in `packages/core/src/plugins/` and are thin lifecycle wrappers.

1. Create `packages/core/src/plugins/my-plugin.ts` exporting a factory that
   returns a `IgnexPlugin` (or a lifecycle fragment).

   ```ts
   // plugins/ratelimit.ts (existing example)
   export const rateLimit = (opts: RateLimitOptions): IgnexPlugin => {
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
   factory like `requireAuth` in `core/src/security/auth.ts`.
2. If you need a **new stage**: add it to `LifeCycleStore` in
   `core/src/types/` (lifecycle types), extend `PRE_HANDLER_STAGES` /
   `POST_HANDLER_STAGES` in `core/src/lifecycle/lifecycle.ts`, update
   `EMPTY_LIFECYCLE`, and **bump
   `COMPILER_CACHE_VERSION`** (codegen embeds the lifecycle stages).
3. Halting semantics: a hook that returns a `Response` halts the chain
   (`{ ok: false, response }`); pass-through hooks must return `undefined` or
   `{ ok: true, ctx }`.

## C: Add a route type / helper

`packages/core/src/http/route.ts` defines the schema-first helpers
(`get`, `post`, …), exposed as the `@ignex/core/http` subpath. Each helper is a
one-line instantiation of the `defineMethod` curried factory with its schema
bound.

1. Add the method helper by instantiating the factory with the right schema
   bounds (`NoBodyRouteSchemas` for GET/DELETE, `BodyRouteSchemas` for body
   methods): `export const get = defineMethod<NoBodyRouteSchemas>();`.
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
   the fallback by default; `IGNEX_NATIVE_PATH` switches to the real addon).

## E: Add a `ctx` member (AOT contract)

This is the one that crosses the compiler boundary — follow it precisely.

1. **shared**: add the flag to `ContextUsage` in `packages/shared/src/context-usage.ts`
   (and to `EMPTY_USAGE` / `FULL_USAGE` if it is universally available).2. **core**: add the member to `IgnexContext` in `core/src/http/context.ts` and
   implement it in `createContext`.
3. **compiler**: add the member name to `USAGE_FLAGS` in
   `utils/ast/usage.ts`; gate the context emission in `phases/codegen/` (the
   `routes.ts` emitter) on the flag. If the member forces the "full context"
   (like `cookie`/`loader`), add it to the `needsFull` condition.
4. **tests**: `packages/compiler/test/ast.test.ts` (usage detection) +
   `packages/core/test/` (runtime behavior).
5. **bump `COMPILER_CACHE_VERSION`** in `packages/compiler/src/cache.ts`.

## F: Add a compiler pass / artifact

1. Add the phase module under `packages/compiler/src/phases/` and wire it into
   the composed pipeline in `src/index.ts` (add a stage to `compileAsync`'s
   `pipeAsync` chain) at the correct point. If the pass needs source (routes,
   app config, hooks), read it through the build's `SourceManager` (parse
   once) and consume `SourceFile`/`RouteIR` — never re-read source directly.
2. Keep phases **pure and testable**: accept inputs, return outputs, report via
   the `DiagnosticCollector` (IGN_* codes in `src/diagnostics.ts`).
3. If the phase changes emitted code, bump `COMPILER_CACHE_VERSION`.
4. Add tests under `packages/compiler/test/` (fixtures live in `test/fixtures/`).

---

## G: Add a store driver

Storage lives on the generic `Store` contract in `packages/core/src/data/store/`
(see [drivers.md](drivers.md)). To add a new backend (e.g. a Redis driver):

1. Create `data/store/redis.ts` implementing the `Store` interface from
   `data/store/types.ts`. Use `resolveExpiry` (from `types.ts`) for TTL
   semantics — every driver shares it so expiry never drifts. Return `null`
   from the factory when the backend is unavailable (matching `sqlite`).
2. Export the factory with full JSDoc from `data/store/index.ts` and the
   top-level `core/src/index.ts` barrel.
3. Register it in `createStoreManager` (`data/store/manager.ts`) if it should
   be a built-in; otherwise document `stores.extend("redis", () => …)` as the
   user-facing path (custom drivers need no core change).
4. Add tests in `packages/core/test/store.test.ts`: round-trip, TTL/expiry,
   `close()`, plus a driver-override test in
   `store-driver-integration.test.ts` proving a consumer (session / jobs /
   cache / rate-limit) uses it.
5. Keep the driver **sync-capable** where possible (the built-ins are
   synchronous after construction); a factory may be async for module
   bootstrap, but the returned methods should return plain values so hot paths
   stay microtask-free.

---

## H: JSDoc on every public API

Because packages ship **source-only** (`exports` point at `src/*.ts`), the JSDoc
in `src/` **is** the consumer-facing API documentation. Every public export
must carry an attached `/** … */` block directly above its declaration. The
`scripts/check-jsdoc.ts` tool walks the export graph from each package's
`exports` map and fails (`--strict`, wired into CI) on any undocumented public
symbol. Run it with `bun run jsdoc:check`.

### The rules

1. **Attach the block directly above the declaration** — nothing but whitespace
   (or `//` line comments) between the `*/` and the `export` keyword:

   ```ts
   /** Interpolate `{name}` placeholders in a template string. */
   export function interpolate(template: string, vars: Record<string, unknown>): string;
   ```

2. **Use `@param` / `@returns` / `@throws`** for anything non-trivial. Always
   document thrown errors for functions that can fail:

   ```ts
   /**
    * Parse a Cache-Control header into its directives.
    *
    * @param header - Raw header value (may be empty).
    * @returns A map of directive name → value (`true` for flags).
    */
   export function parseCacheControl(header: string): Record<string, string | true>;
   ```

3. **`@deprecated`** — mark aliases kept only for back-compat; never leave a
   deprecated symbol undocumented. Prefer removing them outright when breaking
   changes are acceptable.

4. **`@internal`** — mark helpers exported only for cross-module use that are
   not part of the intended public contract.

5. **Types/interfaces/classes are public API too** — document them, including
   their fields when they are consumed directly (options objects, results).

6. **Native `*Fallback` twins** must read as behavior-identical to their native
   counterpart (parity is the contract), not as separate features.

7. Keep the `@fileoverview` file header as the module-level summary; the
   per-symbol JSDoc explains the individual contract.

---

## Quality gates (run before pushing)

```sh
bun run verify          # typecheck + typecheck:cli + lint + test
bun run test:coverage   # tests + coverage thresholds
bun run build && bun run smoke   # AOT compile + boot + assert routes
bun run jsdoc:check     # every public export has attached JSDoc
```

CI (`.github/workflows/ci.yml`) runs all of these on every push/PR.
