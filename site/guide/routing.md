# Routing

Routes are files under `src/routes/`. The **filename** is the contract: it
carries the URL path, the HTTP method, and the dynamic parameters. There is
no router configuration to write — and at runtime there is no JS route
matching either, because the compiler registers every route directly in
[Bun's native routes table](https://bun.com/docs/api/http).

## The route playground

<RoutePlayground />

## The filename conventions

```
src/routes/
├── index.get.ts              → GET  /              (index = the folder root)
├── hello.get.ts              → GET  /hello
├── products/
│   ├── index.get.ts          → GET  /products
│   └── [id].get.ts           → GET  /products/:id  ([name] = path param)
├── auth/login.post.ts        → POST /auth/login
└── files/[...path].get.ts    → GET  /files/*path   ([...name] = catch-all)
```

Rules:

- **Method comes last**: the final `.get`, `.post`, `.put`, `.patch`, or
  `.del` suffix picks the HTTP method.
- **`[name]` segments** become path parameters, exposed as typed
  `ctx.params.name`.
- **`[...name]`** is a catch-all — it matches the rest of the path,
  including slashes.
- **`index`** maps to the folder's root path (or `/` at the top level).

## The handler

A route file exports the handler — either default or named (`httpGet`,
`httpPost`, …) — wrapped in the method helper:

```ts
// src/routes/products/[id].get.ts → GET /products/:id
import { get } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";

export default get(
  async (ctx) => {
    const product = await findProduct(ctx.params.id);
    if (!product) throw new NotFoundError("No such product");
    return ctx.json(product);
  },
  {
    params: Type.Object({ id: Type.String() }),
    response: { 200: Type.Object({ id: Type.String(), name: Type.String() }) },
  },
);
```

The second argument carries the schemas — `params`, `query`, `body`,
`headers`, `response`. They're optional: without them the route still works,
you just don't get validation, typed inputs, or OpenAPI entries. See
[Validation & OpenAPI](./validation).

### What a handler can return

- `ctx.json(...)`, `ctx.text(...)`, `ctx.html(...)` — the usual helpers
- a **plain value** — serialized as JSON
- a `{ status, body }` wrapper
- a raw `Response` — passed through untouched (this is what `ctx.sendFile`
  returns)

Status codes and headers: `ctx.set.status`, `ctx.set.headers`,
`ctx.set.cookie`, `ctx.set.redirect` — applied exactly once to the final
response.

## What the compiler does with your routes

`ignex build` doesn't bundle-and-hope. It emits a server where each route is
specialized:

- **Usage-specialized contexts** — the compiler statically reads which `ctx`
  members your handler touches and builds a context object with only those.
- **Precompiled validators** — your TypeBox schemas become standalone Ajv
  validators at build time, not per-request schema compilation.
- **Per-status serializers** — response shapes are precompiled per status
  code.
- **Constant-response hoisting** — a handler that always returns the same
  response (a health check, a feature flag) is promoted to a pre-built
  `Response` served by Bun in Rust with zero per-request JavaScript.

You never see this machinery — your route files stay plain TypeScript.

## No build step? The interpreted router

Small scripts and tests can skip the compiler entirely — `createRouter()`
gives the same file-free, in-code routing at runtime:

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
    .all("/legacy/*", legacyFallback), // every method on the path
});
```

Paths use Bun syntax (`:id`, `*`). Validation happens at runtime via
Standard Schema (`validateAsync`); invalid input throws a `422
VALIDATION_ERROR`.

**Which to use?** The interpreted router for small tools and tests; the AOT
compiler for everything you'll deploy. The routing story, 404/405/OPTIONS
semantics, and fallbacks are identical — AOT adds precompiled validators,
serializers, constant hoisting, and handler inlining on top.

## Auto-HEAD, OPTIONS, and 405s

You don't register these:

- **HEAD** on a GET route — answered automatically, body stripped.
- **OPTIONS** — a `204` with an `Allow` header (the CORS plugin answers
  preflights here).
- **Known path, wrong method** — `405` with `Allow` listing what *is*
  registered.
- **Unmatched path** — a `404 { error, status, code }` envelope.

All of them still carry your app's default security headers.
