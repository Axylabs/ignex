# @ignex/app

Example application for ignex — the test + benchmark harness for the whole
framework. Every route is real code exercising a compiler or runtime feature.

## Routes (`src/routes/`)

| Route                | File                         | Demonstrates                          |
| -------------------- | ---------------------------- | ------------------------------------- |
| `GET /`              | `index.get.ts`               | constant response hoisting            |
| `GET /health`        | `health.get.ts`              | dynamic JSON                          |
| `GET /hello`         | `hello.get.ts`               | named-export handler (`httpGet`)      |
| `GET /openapi`       | `openapi()` plugin (app.config) | Scalar docs UI (reads `/openapi.json`) |
| `GET /env`           | `env.get.ts`                 | env accessors                         |
| `GET /i18n`          | `i18n.get.ts`                | locale negotiation                    |
| `GET /jobs`          | `jobs.get.ts`                | job queue                             |
| `GET /page`          | `page.get.ts`                | template rendering (Jinja views)      |
| `GET /session`       | `session.get.ts`             | sessions                              |
| `GET /openapi.json`  | `openapi()` plugin (app.config) | serves the generated spec (AOT artifact) |
| `GET/POST /upload`   | `upload.post.ts`             | multipart body parsing                |
| `GET /files/:name`   | `files/[name].get.ts`        | `sendFile` + ranges + traversal guard |
| `GET /products/:id`  | `products/[id].get.ts`       | TypeBox schema validation             |
| `POST /products/add` | `products/add.post.ts`       | body schema                           |
| `POST /auth/register` | `auth/register.post.ts`      | user creation + token issue             |
| `POST /auth/login`    | `auth/login.post.ts`         | access + refresh token issue            |
| `POST /auth/refresh`  | `auth/refresh.post.ts`       | refresh token → new access token        |
| `POST /auth/logout`   | `auth/logout.post.ts`        | revoke refresh token                    |
| `GET /auth/me`        | `auth/me.get.ts`             | `hooks: ["require-auth"]` config hook    |

Hooks live in `src/hooks/` (`require-auth.ts`), global middleware in
`src/middleware/` (a custom `IgnexPlugin` + lifecycle stage hooks), views in
`src/views/` (minijinja templates), and app-level config in `src/app.config.ts`
(plugins + lifecycle + server port).

## Building & running

```sh
bun run build        # AOT-compile -> packages/app/dist/__server.js (+ routes.d.ts, openapi.json, client.ts, manifest.json)
bun run compile      # ALSO emit a standalone executable -> packages/app/dist/ignex-server (minify + bytecode)
bun run smoke        # boot the generated server + assert routes (root scripts/smoke.ts)
bun run dev          # build + watch-run the generated server
```

`builder.ts` drives `@ignex/compiler` with `optimizationLevel: 3`, minify,
context specialization, constant hoisting, and schema precompilation. The app
config sets `server.https: true` (the default), so the dev server serves HTTPS
with an auto-generated local certificate (mkcert → openssl) cached under
`dist/certs`.

## Tests

`packages/app/test/` holds route-level integration tests (see
`refactor.test.ts`). `bun run test` from the root runs the whole suite.
