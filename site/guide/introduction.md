# What is ignex?

ignex is a small, opinionated framework for building HTTP APIs in TypeScript
on [Bun](https://bun.sh). You write your endpoints as **files**. You run one
command. Out comes a compiled server, an OpenAPI document, and a typed client
that already knows your routes.

It feels like the file-based routing you know from Next.js or Nuxt — except
ignex **compiles ahead of time**, so routing, validation, and response
encoding cost almost nothing while the server runs.

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
```

## The three ideas

**1. A file is a route.** The filename carries the path, the HTTP method,
and the params. `products/[id].get.ts` *is* `GET /products/:id`. There is no
router to wire up and no decorators to memorize — see
[Routing](./routing).

**2. Handlers get a typed `ctx`.** Declare a schema and `ctx.params`,
`ctx.query`, and `ctx.body` are typed and validated at the same time. The
same schema flows into the OpenAPI document — see
[Validation & OpenAPI](./validation).

**3. The build is where the speed comes from.** `ignex build` writes a
single `Bun.serve` server with the route table baked in, validators
precompiled, and constant responses hoisted into Bun's Rust routing. No
runtime router and no middleware chain — see [Performance](./performance).

## What you get out of the box

- **HTTPS by default in dev** — local certificates generated for you, HTTP/2
  with one flag.
- **An OpenAPI explorer at `/openapi`** — served from the compiled artifact,
  never hand-maintained.
- **A typed SDK** — `ignex sdk` turns your routes into an npm package your
  frontend can install ([guide](./sdk)).
- **Realtime** — SSE, WebSockets, and typed pub/sub ([guide](./realtime)).
- **A debugger that helps** — request waterfalls, logs, and error
  diagnostics in a dev-only dashboard with zero production footprint.
- **Ship tooling** — `ignex doctor`, `ignex ship`, `ignex ops` walk you from
  "works on my machine" to production ([guide](./deployment)).

## When you'd pick something else

ignex is for HTTP APIs — JSON services, webhooks, realtime backends, full
stacks with server-rendered pages. Reach for something else when you need a
reactivity-driven meta-framework (Next/Nuxt), a mature ecosystem for large
team conventions today (NestJS), or when you cannot use
[Bun](https://bun.sh) as your runtime.

## Coming from somewhere else

| From | What changes |
| --- | --- |
| **Express / Koa** | No `app.get()` wiring — the file path is the route. Handler style stays familiar. |
| **Elysia / Hono** | Similar small-handler feel; ignex compiles the route table ahead of time instead of matching at runtime. |
| **NestJS** | No classes, decorators, or reflection. Functions and explicit composition only. |

## How this documentation works

The **Guide** (the sidebar you're reading) is a learning path: start at
[Getting started](./getting-started), then Essentials, Features, Ship it.
The **[Examples](/examples/)** section is copy-paste walkthroughs of complete
mini-apps, and the **[Cookbook](./cookbook)** is short recipes for specific
tasks. Contributor-facing internals live in the
[repo docs](https://github.com/Axylabs/ignex/tree/main/docs).

Ready? → [Getting started](./getting-started)
