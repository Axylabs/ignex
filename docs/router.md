# Interpreted router (`createRouter`)

The interpreted router gives a `createApp` app Bun-native routing **without a
build step** — the runtime counterpart of the AOT-compiled server's
`stageRouteTable` + `assembleCoreFn`.

## Why

An AOT-compiled app gets a Bun-native `routes` table (Rust path/method
matching), a guarded lifecycle (empty stage chains cost an `if`, not a
Promise), and the compiled reply path. Before the router, an interpreted
`createApp` app had **none** of those: every request ran the single handler's
JS string matching, an always-async lifecycle, and a `Response` passthrough.

`createRouter()` closes most of that gap at runtime:

- **Native routing** — `serve()` registers a Bun-native `routes` table; there
  is no JS trie and no per-request string scan.
- **Guarded lifecycle** — the same stage arrays the compiler emits
  (start→request→parse→transform before validation, the rest after), each
  length-guarded so empty chains cost a single `if`.
- **Shared reply path** — handlers return through the same
  `finalizeResponse`/`jsonReply` helpers the compiled `__finalize` uses
  (one `TextEncoder` pass, exact `content-length`).
- **Same fallbacks** — 404/405/OPTIONS/HEAD match the compiled
  `__fallback`/`__optionsHandler`/`__head` (including auto-`HEAD` for `GET`
  routes and an `Allow`-listing `OPTIONS`).

## Usage

```ts
import { cors, createApp, createRouter } from "@ignex/core";

const app = createApp({
  plugins: [cors()],
  lifecycle: {
    // Runs before every route handler (guarded — skipped when empty).
    beforeHandle: [guard],
  },
  router: createRouter()
    .get("/health", (ctx) => ctx.json({ ok: true }))
    .get("/api/users/:id", (ctx) => ctx.json({ id: ctx.params.id }))
    .post("/users", usersBody, { body: userSchema }) // runtime schema validation
    .all("/legacy/*", legacyFallback),               // every method on the path
});
```

- **Registering** — `get`/`post`/`put`/`patch`/`delete`/`options`/`head`/
  `all`, or `route(method, path, handler, schema?)`. Paths use Bun syntax:
  `/users/:id` (segment param) and `/files/*` (catch-all).
- **Schemas** — the optional second argument to the method helpers validates
  the matching request part at runtime (`validateAsync`): `body`, `query`,
  `params`, `headers`, `cookie`. Invalid input throws a `422
  VALIDATION_ERROR`.
- **Handler returns** — same contract as route files: `ctx.json(...)`,
  `ctx.text(...)`, `ctx.html(...)`, a plain value (serialized as JSON), a
  `{ status, body }` wrapper, or a raw `Response` (passthrough).
- **Set mutations** — `ctx.set.headers` / `ctx.set.cookie` / `ctx.set.status`
  / `ctx.set.redirect` are applied exactly once to the final response.

## Request flow (per route)

```
Bun native router (path/method match)
  → createContext(req, params, { route })
  → guarded pre-parse stages (start→request→parse→transform)
  → runtime schema validation (when a schema is registered)
  → guarded beforeHandle
  → handler(ctx)
  → finalizeResponse (serializer / jsonReply / passthrough)
  → guarded afterHandle + mapResponse
  → applySet exactly once  (headers / status / cookies)
  → error stage on throw (guarded, never masks the original)
```

## Response construction (reply path)

Framework-built responses (`ctx.json` / `text` / `html` on both paths, and the
compiled `__withBody`) share ONE boot-memoized base `Headers` per content-type:
`content-type` plus the app-invariant defaults (plugin `responseDefaults`, e.g.
`security()`, merged with `server.headers`). With no per-request headers the base
is handed to `Response`, which copies it, and only the dynamic `content-length`
is set per request. When per-request headers DO differ (`ctx.set.headers` or an
explicit `init.headers`), the base is CLONED once with a native `Headers` copy
and the request's own headers are applied to the copy — the base is never
mutated, so one instance safely serves concurrent requests. `ResponseInit` is
passed as its three explicit fields (`status`/`statusText`/`headers`) instead of
a destructure + rest-spread of the caller's init object.

Measured (Bun 1.4.2, 9-header set, micro A/B, median of 9 rounds): the
init-headers path fell from ~1582 ns to ~792 ns (**-50%**); the no-init path is
unchanged (~450 ns) and the status-only path fell ~7% (581 -> 538 ns). A
server-bound A/B of the changed branch measured 91.9k -> 94.2k RPS (**+2.5%**).
`Bun.serve`'s `headers` option is silently ignored on 1.4.2, so app static
headers are baked at response CONSTRUCTION (the memoized base), never via a
server sink.

Paths that do NOT construct through that base — a raw `Response` passthrough
(e.g. `ctx.sendFile`, a direct `Response.json`), the 404/405 fallback, the
OPTIONS preflight, an error response, a pre-handler short-circuit — are decorated
by the compiled `__decorateWithDefaults` helper, which fills ONLY the headers the
response does not already carry (route-specific values win) and marks the
response decorated so a decorating plugin's chain skips its static loop. For an
already-baked reply that is a single `WeakSet` probe returned unchanged, so the
hot success path pays no per-header work; with no declared defaults the guard
const-folds away entirely.

## Pre-aborted requests

A request whose `req.signal` is ALREADY aborted before the pipeline starts is
short-circuited to an empty `200` — no hooks, no validation, no handler — on
both paths:

- **Interpreted** — `runLifecycle` checks `ctx.req.signal.aborted` first and
  returns `abortedResponse()` (`packages/core/src/http/abort.ts`).
- **AOT-compiled** — every generated route core fn opens with
  `if (req.signal.aborted) return __abortedResponse;`, where `__abortedResponse`
  is the same shared helper hoisted once at boot. Context creation, the
  pre-handler stages, validation, and the handler are all skipped.

The client is gone, so the work would be wasted; the empty `200` matches the
interpreted path and Elysia. Aborts that happen WHILE handling remain
observable to app code via `ctx.req.signal`, so a slow handler can still cancel
its own work. The behavior is pinned by `packages/core/test/abort-port.test.ts`
(interpreted), `packages/compiler/test/abort-port.test.ts` (compiled), and the
plain-Bun `scripts/verify-aot-abort.ts` (build → boot → invoke).

## Constant-response promotion

A route whose handler provably returns the SAME response for every request is
hoisted to a **pre-built `Response` bound directly into Bun's native routes
table** — Bun serves it in Rust with zero per-request JS, and native auto-HEAD
strips the body while preserving status/headers. Two arms are recognized:

- **JSON arm** — the handler returns a JSON-serializable constant
  (`() => ({ pong: true })`), emitted as `new Response("<json>", { … })`.
- **Response-literal arm** — the handler returns `new Response(body, init)`
  with statically-known arguments (`() => new Response("ok")`,
  `() => new Response("ready", { status: 201, headers: { "x-ready": "1" } })`),
  emitted as the same construction evaluated ONCE at module load. Only
  primitive bodies and a `status`/`statusText`/`headers` init are accepted;
  computed arguments, unknown init keys, non-string header values, and
  non-`Response` constructors fall back to the normal per-request path.

The literal is re-constructed from the exact values the handler wrote, so the
wire bytes and `Response` defaults are identical to a per-request construction.
Hoisting is refused whenever anything could mutate the response: app-level
plugins/lifecycle, route hooks, RBAC guards, route-local `before`/`after`,
validation, a wrapped handler, or trace/access logging. Dev heat capture also
keeps response literals on the normal path.
`packages/compiler/test/compile.test.ts` pins the emitted shape and the
lifecycle refusal.

## 404 / 405 / OPTIONS / HEAD

- **Unmatched path** → `404 { error, status, code }` (same envelope as the
  compiled `__fallback`).
- **Known path, wrong method** → `405` with an `Allow` header computed from
  the registered methods (+ auto-`HEAD`/`OPTIONS`).
- **OPTIONS** → runs the pre-handler chain (so the CORS plugin can answer
  preflight), otherwise a `204` with `Allow`.
- Every one of these paths carries the app's static default headers
  (`server.headers` + plugin `responseDefaults`), applied by
  `__decorateWithDefaults` when they bypass the reply-construction bake
  (`packages/compiler/test/static-defaults-passthrough.test.ts`).
- **HEAD** → auto-answered by the `GET` handler with the body stripped.
- Lifecycle hooks (CORS, security headers) apply to 404/405 responses too,
  matching the compiled server.

## `serve()` vs `handler()`

- `app.serve()` builds `Bun.serve({ routes: router.buildRoutes(), fetch:
  router.fetch })` — native routing, only reachable on Bun.
- `app.handler(req)` dispatches through the registry with JS matching
  (exact-static first, then `:param`/`*` in registration order) so router
  apps work without a server (testing, non-Bun runtimes).

## When to use which

| | Interpreted router | AOT compiler |
| --- | --- | --- |
| Build step | none (runtime) | `@ignex/compiler` `buildAsync` |
| Routing | Bun-native `routes` | Bun-native `routes` |
| Lifecycle | guarded runtime stages | precompiled guarded `if`s |
| Validation | runtime `validateAsync` | precompiled Ajv validators |
| Serializers | `jsonReply` | precompiled per-status serializers |
| Inlining | n/a | handlers inlined when eligible |

Start with the router for simplicity and good performance; move to AOT when you
want precompiled validators/serializers, constant hoisting, and handler
inlining on top of the same routing story.

### Plugin context declarations

The AOT compiler statically computes which `ctx` members each route touches and
emits a usage-specialized context (an object literal with only those members)
instead of the full `IgnexContextImpl`. Plugins are opaque runtime objects — the
compiler can't see which members their hooks read — so an undeclared plugin
forces every route to the full context.

Declaring the plugin's context requirements lets the specialized tier survive
even with user plugins in the pipeline:

1. **`IgnexPlugin.contextUsage`** — a type-safe optional field on the plugin
   object:
   ```ts
   const myPlugin: IgnexPlugin = {
     name: "my-plugin",
     contextUsage: { headers: true, method: true },
     onRequest(ctx) { /* reads ctx.headers and ctx.method */ },
   };
   ```

2. **Module-level `export const contextUsage`** — the audited,
   machine-readable form for compiled builds:
   ```ts
   export const contextUsage = { headers: true, method: true };
   ```
   The compiler reads this statically from the plugin module via the build's
   `SourceManager`; the field on the object is the runtime-visible API surface
   (introspection, interpreted tooling).

Only `true` values are meaningful. Unknown members are rejected. A member the
specialized context cannot emit (e.g. `ip`, `debug`) also forces the full
context — the fail-safe rule: **the compiler never hands a hook `undefined` on a
specialized route.** An undeclared plugin keeps today's behavior: the full
context for every route.

## Tests

`packages/core/test/router.test.ts` (dispatch, params, wildcards, schemas,
error/afterResponse hardening, set application) and
`packages/core/test/router-utils.test.ts` (path compilation, arg extraction).
