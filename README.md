# ignex

ignex is a small, opinionated framework for building HTTP APIs in TypeScript on
[Bun](https://bun.sh). You write your endpoints as files. You run one command.
Out comes a compiled server, an OpenAPI document, and a typed client that already
knows your routes.

That is the whole idea. Most of this page is about how it feels in practice.

If you've used a file-based router before (Next.js API routes, Nuxt server
routes), the shape will look familiar — except ignex compiles ahead of time, so
routing, validation and response encoding cost almost nothing while the server
runs.

## Try it

You need Bun 1.4 or newer. Nothing else.

```sh
bun create ignex my-api
cd my-api
bun install
bun run dev
```

Open https://localhost:3000 and you'll see the welcome route. Now add one of
your own. Create `src/routes/hello.get.ts`:

```ts
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("Hello, world!"));
```

Save the file and https://localhost:3000/hello is live. The dev server
recompiles and restarts on every change, so you never run a second terminal to
watch it.

If you'd rather start with more in the box — auth and sessions, OpenAPI, example
routes, a test — say so at scaffold time:

```sh
bun create ignex my-api --features auth,sessions,openapi,examples,tests
```

One thing worth knowing on day one: **dev serves HTTPS by default**, using a
locally-trusted certificate it generates for you (mkcert if you have it, openssl
if you don't). If neither is available it falls back to HTTP with a note in the
console and carries on. There is nothing to configure before you start.

## The three ideas

Everything else follows from these.

**1. A file is a route.** The folder path and the method suffix in the filename
are the route. `hello.get.ts` is `GET /hello`; `products/[id].get.ts` is
`GET /products/:id`; `files/[...path].get.ts` is `GET /files/*path`. There is no
router to register, no decorators to remember.

**2. Handlers get a typed `ctx`.** Params, query, the lazy body, headers,
cookies, and the reply helpers (`ctx.json`, `ctx.text`, `ctx.html`) are all on
one object. Attach a schema and the types follow it.

**3. The build is where the speed comes from.** `ignex build` walks your routes,
compiles the validators and the response bodies, and writes a single `Bun.serve`
server. No runtime router and no middleware chain — just the parts Bun is
fastest at.

You don't have to build, either. There's an interpreted `createApp` +
`createRouter` path with the same handler style and the same routing. The
[router docs](docs/router.md) explain when each is worth it.

## A slightly bigger route

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

Pass a schema and three things happen at once: the input is validated (a
structured `422` when it isn't right), `ctx` is typed from the schema, and the
same schema flows into your OpenAPI document. Schemas can be TypeBox or any
Standard Schema library — zod, valibot, and friends all work.

Throw an error and it becomes the right response on its own: `NotFoundError` →
`404`, `UnauthorizedError` → `401`, `TooManyRequestsError` → `429`, and so on, or
`HTTPError(status, message)` for anything else.

## What's in the box

The point of ignex is that the boring parts are already there, so you spend your
time on your app instead of on wiring.

- **HTTP** — file routes, params/query/body parsing, streaming, SSE, WebSockets,
  static files, range requests, uploads, proxies.
- **Data** — validated environment config, [SQL and Mongo drivers](docs/drivers.md),
  caching, rate limiting, background jobs (in-process or durable).
- **Security** — JWT (HS256 and Ed25519), signed cookies, sessions, CSRF,
  password hashing, security headers, CORS.
- **Developer experience** — an OpenAPI 3.1 document and interactive docs UI, a
  generated [typed client](docs/sdk.md), i18n, templates, test helpers, and a dev
  dashboard.
- **Tooling** — the AOT compiler, a CLI that scaffolds routes/models/hooks, and
  deployment files for Docker, Compose, Caddy and CI.

Hot paths (hashing, crypto, HTTP parsing, compression, JSON validation, template
rendering) can run through a Rust addon called **castrum**, with a
byte-identical TypeScript fallback when it isn't installed. Native is a speed
boost, never a requirement — `IGNEX_NATIVE=off` is a fully supported mode.

## After a build

`bun run build` writes into `.ignex/`:

| File | What it is |
| --- | --- |
| `server.js` | the compiled server — run it with `bun run start` |
| `openapi.json` | an OpenAPI 3.1 spec derived from your real schemas |
| `client.ts` | a typed HTTP client for your frontend |
| `routes.d.ts` | the route map that client is typed from |
| `manifest.json` | per-route metadata for tooling |

Add the `openapi()` plugin in `src/app.config.ts` and `GET /openapi` serves an
interactive docs UI while `GET /openapi.json` serves the spec.

## Coming from somewhere else

- **Express or Koa** — there's no `app.get(...)`; the file path *is* the route.
  Middleware becomes lifecycle hooks in `src/app.config.ts`.
- **Elysia or Hono** — similar handler style, but ignex compiles the route table
  ahead of time and owns the build output.
- **NestJS and decorators** — no classes and no reflection. Handlers are plain
  functions and the wiring lives in one config file.

## Learn more

The documentation hub is [docs/README.md](docs/README.md) — every doc, who it is
for, and how settled it is. The short version:

- **[Getting started](docs/getting-started.md)** — the full walkthrough, scaffold
  to first build.
- **[Cookbook](docs/cookbook.md)** — copy-paste recipes for auth, sessions, jobs,
  SSE, WebSockets, i18n, templates, caching and more.
- **[Router](docs/router.md)** — the interpreted path and the request lifecycle.
- **[Deployment](docs/deployment.md)** — standalone binaries, Docker, proxies,
  multi-instance setups.
- **[Debugbar](docs/debugbar.md)** — the dev-only dashboard: request waterfall,
  logs, metrics, replay.
- **[Example app](packages/app/README.md)** — a reference app that exercises the
  whole feature set.

## Status

ignex is pre-1.0 and moving. The compiler, CLI, runtime, security suite and
native bridge are tested end to end and green in CI, but the API can still change
between releases — `CHANGELOG.md` records every change. Known limitations and
open work live in [docs/stability.md](docs/stability.md).

Next up: prebuilt `castrum` binaries for all platforms, OAuth2/OIDC providers,
wider Standard Schema coverage, and i18n catalog reloading.

## Working on ignex

This repository is the monorepo: the compiler, the runtime, the CLI, the native
bridge, and the reference app.

```sh
bun install
bun run dev             # compile + watch the example app
bun run verify:quick    # typecheck + lint + jsdoc — the fast gate
bun run verify          # the fast gate plus tests and the dead-code scan
```

Before opening a pull request, read [CONTRIBUTING.md](CONTRIBUTING.md) and the
short, non-negotiable [RULES.md](RULES.md). New to the codebase?
[AGENTS.md](AGENTS.md) has an onboarding section (run it, the three-layer mental
model, three first exercises).

## License

MIT — see [LICENSE](LICENSE).
