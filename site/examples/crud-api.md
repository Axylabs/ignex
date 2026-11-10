# CRUD API

The list / detail / create / update / delete pattern for a resource — with
TypeBox validation, pagination, and typed errors. Five files, no boilerplate
base classes, and every input validated before your handler runs.

**You'll need**: a running dev server ([Getting started](../guide/getting-started)).

## The resource shape

All five routes under `src/routes/products/`:

```
src/routes/products/
├── index.get.ts            → GET    /products        (list, paginated)
├── index.post.ts           → POST   /products        (create)
├── [id].get.ts             → GET    /products/:id    (detail)
├── [id].patch.ts           → PATCH  /products/:id    (update)
└── [id].del.ts             → DELETE /products/:id    (delete)
```

## The schema (declared once)

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

## List with pagination

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

## Create (validated body)

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

## Detail, update, delete — with typed errors

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

## What to notice

- **Five routes, zero router config** — filenames only.
- **Errors are throws**, not status-code plumbing; the framework maps them.
- **The OpenAPI doc updated itself** as you added routes — check `/openapi`.

Want this backed by real SQL? `ignex resource Product --db sql --fields
"name:string,priceCents:integer,active:boolean"` scaffolds the Drizzle
model and CRUD routes — see [Data](../guide/data#sql-via-drizzle-ignex-resource).
