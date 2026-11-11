# CRUD API

Two ways to a full resource — list / detail / create / update / delete with
validation, pagination, and typed errors:

1. **One command** — `ignex resource` generates the model, the five routes,
   the shared client, and migrations config. Start here.
2. **By hand** — five small files, if you want to see (or control) every
   piece yourself.

**You'll need**: a running dev server ([Getting started](../guide/getting-started)).

## Path 1: `ignex resource` — the whole stack in one command

```sh
ignex resource Product --db sql --fields "name:string,priceCents:integer,active:boolean"
```

That single command generates a working, validated CRUD API:

```
src/
├── models/products.ts          # typed Drizzle table ($inferSelect / $inferInsert)
├── db-sql.ts                   # shared client (bun:sqlite with WAL) — created once
├── routes/api/products/
│   ├── index.get.ts            # GET    /api/products   — list, validated, paginated
│   ├── index.post.ts           # POST   /api/products   — create, validated body
│   ├── [id].get.ts             # GET    /api/products/:id
│   ├── [id].patch.ts           # PATCH  /api/products/:id
│   └── [id].del.ts             # DELETE /api/products/:id
└── drizzle.config.ts           # drizzle-kit config → migrations
```

Try it immediately — the dev server picks the new routes up:

```sh
curl -k -X POST https://localhost:3000/api/products \
  -H 'content-type: application/json' \
  -d '{"name": "Ignex tee", "priceCents": 1900, "active": true}'
# → 201 {"id": 1, "name": "Ignex tee", "priceCents": 1900, "active": true}

curl -k -X POST https://localhost:3000/api/products \
  -H 'content-type: application/json' -d '{"name": ""}'
# → 400 — validated TypeBox input rejects it before any handler code runs

curl -k "https://localhost:3000/api/products?page=1&pageSize=10"
# → paginated envelope: { items, page, pageSize, total, pageCount }
```

Migrations are the same CLI:

```sh
ignex migrate create add-profile --db sql   # drizzle-kit generate
ignex migrate up --db sql                   # drizzle-kit migrate
```

Variants:

```sh
ignex resource User --db sql --sql-driver postgres   # PostgreSQL native columns
ignex hotroute Gig --fields "name:string, price:number"
# same CRUD, but routes stay THIN and the logic lives in src/modules/<plural>/
# with a hot-cached get-one path (change-stream invalidated)
```

- SQL means [Drizzle](https://orm.drizzle.team) — a typed table in
  `src/models/`, not a new ORM. `--db mongo` uses the ninox toolkit with the
  same route contract and field DSL.
- Dialects are per-project: adding another resource never overwrites an
  existing client/config.
- New resources **merge** into an existing `src/db.ts` automatically.
- Open this in the [debugbar](../guide/debugbar) — every CRUD request shows
  its waterfall, the exact Drizzle query, and the wire result.

::: tip When to use `hotroute`
`ignex resource` is the straightforward stack. `ignex hotroute` is the same
CRUD with a read-cache: one file per operation under `src/modules/<plural>/`,
routes reduced to params/query/status plumbing. Reach for it when a resource
is read-heavy.
:::

## Path 2: by hand — five files

Writing the routes yourself (or customizing the generated ones) looks like
this. All five under `src/routes/products/`:

```
src/routes/products/
├── index.get.ts            → GET    /products        (list, paginated)
├── index.post.ts           → POST   /products        (create)
├── [id].get.ts             → GET    /products/:id    (detail)
├── [id].patch.ts           → PATCH  /products/:id    (update)
└── [id].del.ts             → DELETE /products/:id    (delete)
```

### The schema (declared once)

```ts
// src/models/product.ts
import { Type } from "typebox";

export const ProductSchema = Type.Object({
  id: Type.String(),
  name: Type.String({ minLength: 1, maxLength: 200 }),
  priceCents: Type.Integer({ minimum: 0 }),
  active: Type.Boolean({ default: true }),
});

export const ProductInput = Type.Omit(ProductSchema, ["id"]);
```

### List with pagination

```ts
// src/routes/products/index.get.ts → GET /products
import { get, pageSchema, readPagination, pageResponse } from "@ignex/core/http";
import { Type } from "typebox";
import { ProductSchema } from "../../models/product";

export default get(
  async (ctx) => {
    const page = readPagination(ctx); // ?page=&pageSize= — clamped, tolerant
    const { rows, total } = await listProducts(page); // your data layer
    return ctx.json(pageResponse(rows, page, total));
  },
  {
    response: {
      200: pageSchema(Type.Omit(ProductSchema, ["id"])),
    },
    detail: { summary: "List products" },
  },
);
```

`readPagination` + `pageResponse` + `pageSchema` are a matched set from
`@ignex/core/http` — the envelope the schema documents is exactly the
envelope you return, so they can't drift.

### Create (validated body)

```ts
// src/routes/products/index.post.ts → POST /products
import { post } from "@ignex/core/http";
import { Type } from "typebox";
import { ProductInput } from "../../models/product";

export default post(
  async (ctx) => {
    const input = ctx.body.json(); // typed + validated by the schema below
    const product = await createProduct(input);
    return ctx.json(product, { status: 201 });
  },
  {
    body: ProductInput,
    response: { 201: ProductSchema },
    detail: { summary: "Create a product" },
  },
);
```

```sh
curl -k -X POST https://localhost:3000/products \
  -H 'content-type: application/json' \
  -d '{"name": "Ignex tee", "priceCents": 1900, "active": true}'
# → 201 {"id": "prd_1", "name": "Ignex tee", …}

curl -k -X POST https://localhost:3000/products \
  -H 'content-type: application/json' \
  -d '{"name": "", "priceCents": -5}'
# → 422 {"code": "VALIDATION_ERROR", "details": {"fieldErrors": { … }}}
```

### Detail, update, delete — with typed errors

```ts
// src/routes/products/[id].get.ts → GET /products/:id
import { get } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";

export default get(
  async (ctx) => {
    const product = await findProduct(ctx.params.id);
    if (!product) throw new NotFoundError("No such product"); // → 404, no try/catch
    return ctx.json(product);
  },
  {
    params: Type.Object({ id: Type.String() }),
    response: { 200: ProductSchema },
  },
);
```

```ts
// src/routes/products/[id].patch.ts → PATCH /products/:id
import { patch } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";
import { ProductInput } from "../../models/product";

export default patch(
  async (ctx) => {
    const patchInput = ctx.body.json();
    const product = await updateProduct(ctx.params.id, patchInput);
    if (!product) throw new NotFoundError("No such product");
    return ctx.json(product);
  },
  {
    params: Type.Object({ id: Type.String() }),
    body: Type.Partial(ProductInput),
    response: { 200: ProductSchema },
  },
);
```

```ts
// src/routes/products/[id].del.ts → DELETE /products/:id
import { del, OkResponse } from "@ignex/core/http";
import { NotFoundError } from "@ignex/core";
import { Type } from "typebox";

export default del(
  async (ctx) => {
    const deleted = await deleteProduct(ctx.params.id);
    if (!deleted) throw new NotFoundError("No such product");
    return ctx.json(OkResponse); // { ok: true }
  },
  {
    params: Type.Object({ id: Type.String() }),
    response: { 200: Type.Object({ ok: Type.Boolean() }) },
  },
);
```

## What to notice

- **Five routes, zero router config** — filenames only.
- **Errors are throws**, not status-code plumbing; the framework maps them.
- **The OpenAPI doc updated itself** as you added routes — check `/openapi`.
- Every request of this resource is visible in the
  [debugbar](../guide/debugbar) — waterfall, queries, replay.

## Generate the client, consume it

```sh
bun run build    # regenerates openapi.json + client.ts with all five routes
```

```ts
import { createClient } from "@ignex/core"; // or the generated client.ts

const api = createClient("https://localhost:3000");
const page = await api.products.get({ query: { page: 2 } }); // typed
```

For a standalone installable SDK package, see the
[typed client example](/examples/typed-client).

Want the full tour of what the CLI can scaffold — auth, events, hot routes,
deployment files? [Take the tour →](../guide/tour)
