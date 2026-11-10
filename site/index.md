---
layout: home

hero:
  name: "ignex"
  text: "Routes are files."
  tagline: "The AOT-first TypeScript framework on Bun. Write endpoints as files — one command compiles them into an optimized server, an OpenAPI document, and a typed client. No runtime router. No middleware chain."
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: What is ignex?
      link: /guide/introduction
    - theme: alt
      text: Examples
      link: /examples/

features:
  - icon: 🗂️
    title: A file is a route
    details: products/[id].get.ts becomes GET /products/:id. The filename carries the path, the method, and the params — the compiler turns every file into an entry in Bun's native routes table.
    link: /guide/routing
    linkText: How routing works
  - icon: 🛡️
    title: One schema, three jobs
    details: Declare a TypeBox (or zod, or valibot) schema once — it validates the request, types your handler's ctx, and flows into the OpenAPI document. Precompiled validators run at build time.
    link: /guide/validation
    linkText: Validation & OpenAPI
  - icon: 📦
    title: A typed client for free
    details: Every build emits openapi.json and a zero-dependency typed SDK your frontend can npm install — generated from the same artifacts the server was built from, so it can't drift.
    link: /guide/sdk
    linkText: SDK generation
  - icon: 🌊
    title: Realtime, typed end to end
    details: SSE from an async generator, WebSockets with bounded dispatch, and nova pub/sub with direction-typed events. Rooms, per-user delivery, cluster sync.
    link: /guide/realtime
    linkText: Realtime guide
  - icon: 🔍
    title: A debugger that helps
    details: The dev-only debugbar shows every request's waterfall, logs, queries and errors — with AI-readable endpoints for your editor's agent. Zero production impact.
    link: /guide/plugins-and-config#the-debugbar
    linkText: Debugbar
  - icon: 🦀
    title: Rust speed, TypeScript safety
    details: The castrum addon accelerates the hot paths natively — and if it's missing, byte-compatible pure-TS fallbacks take over. Native is a speed boost, never a requirement.
    link: /guide/performance
    linkText: Performance story
---

<div class="vp-doc" style="max-width: 1152px; margin: -32px auto 0; padding: 0 24px;">

## Your first API in 60 seconds

```sh
bun create ignex my-api
cd my-api
bun install
bun run dev
```

```ts
// src/routes/hello.get.ts → GET /hello
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello World"));
```

That's the whole app. Run `bun run build` and ignex compiles it into `.ignex/`:

| Artifact        | What you get                                            |
| --------------- | ------------------------------------------------------- |
| `server.js`     | An optimized `Bun.serve` server — routes baked in       |
| `openapi.json`  | An OpenAPI 3.1 spec derived from your real schemas      |
| `client.ts`     | A typed HTTP client that already knows your routes      |
| `routes.d.ts`   | Typed route context (params / query / body / responses) |

**HTTPS is on by default in dev.** Local certs are generated for you, and
`GET /openapi` serves an interactive API explorer — of your actual routes.

## Play with it right here

<ApiExplorer />

Like what the compiler generates? [See the full walkthrough →](/examples/)

## Coming from somewhere else?

<div class="ignex-strip">

<div class="ignex-strip-item">

**From Express or Koa** — there is no `app.get()` to wire up: the file path
*is* the route. Keep your handler style; lose the router plumbing.

</div>

<div class="ignex-strip-item">

**From Elysia or Hono** — a similar small-handler feel, but ignex compiles the
route table ahead of time, so routing, validation and response encoding cost
almost nothing while the server runs.

</div>

<div class="ignex-strip-item">

**From NestJS** — no classes, no decorators, no reflection. Handlers are
functions, dependencies are explicit, and the framework stays out of your
domain code.

</div>

</div>

## Honest about speed

ignex doesn't publish "Nx faster than X" claims — it publishes
[a methodology](/guide/performance). A few measured numbers from its own
benchmarks, run with the same discipline every time:

- **Native ingress** parses query + cookies at ~90k RPS vs ~48k for the JS
  `URLSearchParams` path.
- A **full native route call** runs in ~11.4µs vs ~13.8µs pure-TS on the same
  payload (60 params, 30 cookies).
- The pure-TS fallback is **byte-identical** — `IGNEX_NATIVE=off` is a
  supported mode and a CI gate, so the story is the same on every machine.

<div style="text-align: center; margin-top: 32px;">
  <a href="/guide/getting-started" class="ignex-badge" style="font-size: 14px; padding: 8px 20px;">Start building →</a>
</div>

</div>
