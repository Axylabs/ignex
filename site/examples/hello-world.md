# Hello, world

The smallest possible ignex API — one file — then a two-minute upgrade to a
validated, parameterized route. Everything here works the same way in a
project scaffolded five minutes ago and in a 200-route service.

**You'll need**: [Getting started](../guide/getting-started) finished (a
running `bun run dev`).

## Step 1: the whole app

Create `src/routes/hello.get.ts`:

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
```

That's it — the dev server already recompiled. Try it:

```sh
curl -k https://localhost:3000/hello
# Hello World
```

::: tip Named exports work too
`export const httpGet = get(() => "Hello World")` — default or named, both
compile to the same native route entry. A handler returning a plain string
is serialized as JSON; wrap it in `ctx.text(...)` to send plain text.
:::

## Step 2: a path parameter

Create `src/routes/hello/[name].get.ts`:

```ts
// src/routes/hello/[name].get.ts → GET /hello/:name
import { get } from "@ignex/core/http";
import { Type } from "typebox";

export default get(
  (ctx) => ctx.text(`Hello, ${ctx.params.name}!`),
  {
    params: Type.Object({ name: Type.String({ minLength: 1 }) }),
  },
);
```

```sh
curl -k https://localhost:3000/hello/Ada
# Hello, Ada!

curl -k "https://localhost:3000/hello/%20"
# {"error":"Validation failed","status":422,"code":"VALIDATION_ERROR", …}
```

## Step 3: look at what you got — without writing anything

Open these in a browser:

- **`https://localhost:3000/openapi`** — interactive docs for both routes,
  generated from your TypeBox schemas.
- **`https://localhost:3000/openapi.json`** — the raw OpenAPI 3.1 document.
- **`https://localhost:3000/__debugbar/`** — the dev dashboard: your
  requests, their waterfalls, and logs.

Then run the production build and look at the artifacts:

```sh
bun run build
ls .ignex/
# server.js  openapi.json  client.ts  routes.d.ts  manifest.json
```

`client.ts` is a typed HTTP client that already knows both routes. That's
the [typed client example](/examples/typed-client).

## What to notice

- **No router registration.** The filename *was* the route definition.
- **The schema did three jobs.** Validation, `ctx.params` typing, and the
  OpenAPI entry — one declaration.
- **422 errors are field-scoped.** Your frontend can highlight the exact
  input that failed.

Next: [CRUD API](/examples/crud-api) — the full list/detail/create/update/
delete pattern with pagination and typed errors.
