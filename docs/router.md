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

## 404 / 405 / OPTIONS / HEAD

- **Unmatched path** → `404 { error, status, code }` (same envelope as the
  compiled `__fallback`).
- **Known path, wrong method** → `405` with an `Allow` header computed from
  the registered methods (+ auto-`HEAD`/`OPTIONS`).
- **OPTIONS** → runs the pre-handler chain (so the CORS plugin can answer
  preflight), otherwise a `204` with `Allow`.
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

## Tests

`packages/core/test/router.test.ts` (dispatch, params, wildcards, schemas,
error/afterResponse hardening, set application) and
`packages/core/test/router-utils.test.ts` (path compilation, arg extraction).
