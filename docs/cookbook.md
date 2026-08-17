# Cookbook

> Short, copy-pasteable recipes for the `@ignex/core` primitive catalog. Every
> snippet mirrors code the scaffold (`ignex create`) generates, so it is known
> to compile against the current API. See
> [Getting Started](getting-started.md) first.

All routes are files under `src/routes/`; the path + method come from the
filename and the handler is a named (`httpGet`) or default export.

## Routes & responses

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
// ctx.json(...), ctx.html(...), ctx.text(...), ctx.status / ctx.headers
```

Dynamic params (`src/routes/products/[id].get.ts` → `GET /products/:id`):

```ts
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.json({ id: ctx.params.id }));
```

Request bodies (JSON, multipart, form):

```ts
// src/routes/upload.post.ts → POST /upload
import { post } from "@ignex/core/http";

export default post(async (ctx) => {
  const form = await ctx.body.formData();
  const file = form.get("file");
  return ctx.json({ uploaded: file instanceof File ? file.name : null }, { status: 201 });
});
```

`ctx.body.json()`, `ctx.body.formData()`, `ctx.body.text()` are lazy — the body
is only parsed when you read it.

## Validation & OpenAPI

```ts
// src/routes/products/[id].get.ts
import { get } from "@ignex/core/http";
import { Type } from "@sinclair/typebox";

export default get(
  {
    params: Type.Object({ id: Type.String() }),
  },
  (ctx) => ctx.json({ id: ctx.params.id }),
);
```

Schemas are precompiled to standalone validators/serializers at build time and
flow into the generated `openapi.json`. Serve it from a route:

```ts
// src/routes/openapi.json.get.ts → GET /openapi.json
import { get } from "@ignex/core/http";
import { generateOpenAPI } from "@ignex/core";

export default get((ctx) => ctx.json(generateOpenAPI({ title: "my-api", version: "0.1.0" }, [])));
```

## Plugins & config (`src/app.config.ts`)

```ts
import { compression, cors, security, session } from "@ignex/core";

export const plugins = [
  cors(),
  compression(),
  security(),
  session({ secret: process.env.SESSION_SECRET ?? "dev-secret-change-me", createIfMissing: true }),
];

export const server = { port: Number(process.env.PORT ?? 3000) };
```

Also available: `rateLimit()`, `logger()`, `csrf()` — all registered in the
same `plugins` array. Global hooks go in a `lifecycle` export:

```ts
export const lifecycle = { beforeHandle: [logRequests(), markResponse()] };
```

## Hooks & auth

Per-route hooks via `config`:

```ts
// src/routes/me.get.ts
import { get } from "@ignex/core/http";

export default get(
  { hooks: ["require-auth"] },
  (ctx) => ctx.json({ user: ctx.user }),
);
```

Full auth stack: `authModule()` (Ed25519 access tokens), `createPasswordHasher`
(argon2id/scrypt), in-memory user store, and the `require-auth` hook — scaffold
it with `bunx @ignex/cli@latest create my-api --features auth`.

## Sessions

```ts
import { get } from "@ignex/core/http";
import { getSession } from "@ignex/core";

export default get(async (ctx) => {
  const session = getSession(ctx);
  if (!session) return ctx.json({ session: null });

  const visits = ((session.data.visits as number | undefined) ?? 0) + 1;
  session.data.visits = visits;
  await session.save();

  return ctx.json({ id: session.id, visits, isNew: session.isNew });
});
```

## Server-sent events (SSE)

```ts
import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";

export default get(() =>
  sse(async function* () {
    yield { event: "ping", data: Date.now().toString() };
  }),
);
```

## WebSockets

```ts
// src/ws.example.ts (wired via config)
import { createWSHandler } from "@ignex/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignex");
  },
  message(ws, message) {
    ws.send(String(message));
  },
});
```

## Caching

```ts
import { get } from "@ignex/core/http";
import { withBrowserCache } from "@ignex/core";

export default get(() => withBrowserCache(ctx.json({ cached: true }), { maxAge: 10 }));
```

Lower-level: `cacheControl`, `parseCacheControl`, `HttpResponseCache`
(stale-while-revalidate), `etagWithEncoding`, and conditional requests.

## Proxying

```ts
import { get } from "@ignex/core/http";
import { proxyRequest } from "@ignex/core";

export default get(() => proxyRequest("https://example.com"));
```

Also `forwardRequest` for pass-through proxying.

## Static files & downloads

```ts
import { get } from "@ignex/core/http";
import { sendFile } from "@ignex/core";

// GET /files/:name — range requests + traversal guard built in
export default get((ctx) => sendFile(ctx, join("public", ctx.params.name)));
```

## Background jobs

```ts
import { get } from "@ignex/core/http";
import { createJobQueue, withRetry, withTimeout } from "@ignex/core";

const queue = createJobQueue({ concurrency: 2 });

const task = withTimeout(5000)(
  withRetry(2)(async () => {
    // do work
  }),
);

export default get((ctx) => {
  queue.enqueue("demo", task);
  return ctx.json({ enqueued: true, pending: queue.pending, running: queue.running });
});
```

For durable, crash-recoverable jobs use `createDurableJobQueue` with
`createFileJobStore` / `createSqliteJobStore` (claim/lease, retries with
backoff, recurring jobs).

## Templates

Jinja-compatible rendering (native minijinja, JS fallback):

```ts
import { get } from "@ignex/core/http";
import { createTemplateDir, withLayout } from "@ignex/core";
import { join } from "node:path";

export default get(async (ctx) => {
  const registry = await createTemplateDir(join(process.cwd(), "src/views"));
  const page = withLayout((content, data) =>
    registry.render("layout", { ...data, content }),
  )((data) => registry.render("home", data));

  return ctx.html(page({ title: "Ignex app", name: "world" }));
});
```

Also `createTemplateRegistry`, `createTemplate`, `renderTemplate`.

## i18n

```ts
import { get } from "@ignex/core/http";
import { createI18n } from "@ignex/core";

const i18n = createI18n(
  { en: { greeting: "Hello {name}" }, es: { greeting: "Hola {name}" } },
  { fallbackLocale: "en" },
);

export default get((ctx) => {
  const locale = i18n.locale(ctx);
  return ctx.json({ locale, message: i18n.t("greeting", { name: "world" }, locale) });
});
```

JSON catalogs (`locales/*.json`) load via `createI18nFromDir` / `loadCatalogDir`;
`withI18n` middleware exposes `ctx.t`.

## Config & env

```ts
import { get } from "@ignex/core/http";
import { defineConfig, env, loadEnv } from "@ignex/core";

loadEnv();

const config = defineConfig({
  PORT: { type: "number", default: 3000 },
  NODE_ENV: { type: "string", default: "development" },
});

export default get((ctx) =>
  ctx.json({ port: config.PORT, direct: env("SOME_VAR", "fallback") }),
);
```

Typed accessors: `env`, `envInt`, `envBool`, `envFloat`, `envJson`, `envSecret`.

## Generated client

```ts
import { createClient } from "@ignex/core";

const api = createClient("http://localhost:3000");
const res = await api.products.get({ params: { id: "123" } }); // typed from client.ts
```

`client.ts` is regenerated on every build with types derived from your routes
and schemas.
