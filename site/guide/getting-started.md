# Getting started

In about five minutes you'll scaffold a project, write a few routes, add
validation, and build a production artifact. The only prerequisite is
[curiosity](https://bun.sh) — the CLI is fetched on demand, nothing is
installed globally.

## 1. Prerequisites

- [Bun](https://bun.sh) ≥ 1.4 — or nothing at all: every scaffolded project
  ships `setup.sh` (macOS/Linux) and `setup.bat` (Windows) that install Bun
  for you, then provision the rest.

## 2. Create a project

```sh
bunx @ignex/cli@latest create my-api --features auth,openapi,examples
cd my-api
bash setup.sh          # Windows: setup.bat  (installs Bun if missing, then provisions)
bun run dev
```

::: tip The fastest path
`bun create ignex my-api` is the short form — it scaffolds with the default
feature set (`openapi,examples,tests`). Pass `--features` when you know what
you want, or `--features all` to get everything wired.
:::

`setup.sh` hands off to the scaffold's provisioner, which:

1. copies `.env.example` → `.env` (skipped when one exists),
2. installs missing tooling (`git` by default; `--docker` / `--caddy` add
   Docker Engine / Caddy),
3. runs `bun install` and `bun run build`,
4. smoke-tests: boots the compiled server on a free port and polls
   `GET /health` — proof the scaffold works on this machine.

### What you got

```
my-api/
├── src/
│   ├── routes/          ← your API lives here (hello world is included)
│   ├── app.config.ts    ← plugins, lifecycle, server config
│   ├── config/env.ts    ← validated environment schema
│   └── lib/             ← auth, logger, shared code
├── test/                ← a scaffolded integration test
└── ignex.config.mjs     ← typed compiler/SDK overrides (rarely touched)
```

### The dev server

`bun run dev` compiles, starts, and restarts on every change. Two things to
notice in the output:

```
ℹ Native: native (castrum)         # Rust acceleration active
ignex listening on https://localhost:3000
[ignex] openapi: https://localhost:3000/openapi — API docs UI
```

- The `Native:` line tells you whether the Rust addon is active. If it says
  `off (pure-TS fallback)`, everything still works — identically. See
  [Performance](./performance).
- **HTTPS is on by default.** ignex generated a locally-trusted certificate
  for you (via mkcert or openssl). Point your browser at the URL above and
  click through the self-signed warning — or run
  `bunx @ignex/cli create` with `--protocol http` next time if you prefer
  plain HTTP in dev.

## 3. Your first route

Routes are files under `src/routes/`; the path and method come from the
filename. Try it — create `src/routes/bye.get.ts`:

```ts
// src/routes/bye.get.ts → GET /bye
import { get } from "@ignex/core/http";

export default get((ctx) => ctx.text("See ya!"));
```

Save. The dev server recompiles and restarts — `GET /bye` now answers.
[Routing](./routing) explains every filename convention (params, catch-alls,
all methods).

Scaffold routes instead of hand-writing them:

```sh
bun run route -- products/[id].get --schema   # route + TypeBox schema stub
ignex hook require-auth                       # named per-route hook
ignex hook log-requests --global              # global lifecycle hook
```

## 4. Add validation

Change `bye.get.ts` to echo a path parameter — declare a TypeBox schema as
the second argument and `ctx.params` becomes typed *and* validated:

```ts
// src/routes/hello/[name].get.ts → GET /hello/:name
import { get } from "@ignex/core/http";
import { Type } from "typebox";

export default get((ctx) => ctx.text(`Hello, ${ctx.params.name}!`), {
  params: Type.Object({ name: Type.String({ minLength: 1 }) }),
});
```

One schema, three jobs: it validates the request (a bad `name` gets a `422`
with per-field errors), it types `ctx.params`, and it flows into
`openapi.json`. That's the core ignex idea — see
[Validation & OpenAPI](./validation).

## 5. Build, run, and check

```sh
bun run build     # AOT-compile → .ignex/server.js + openapi.json + client.ts + routes.d.ts
bun run start     # run the compiled server
bun run compile   # also emit a standalone binary (Bun runtime embedded)
bun run typecheck # strict TS check
bun run test      # vitest
```

The compiled `server.js` is the production artifact — routes baked into
Bun's native table, validators precompiled, dev tooling stripped. See
[Deployment](./deployment).

Diagnose a project without building:

```sh
bunx @ignex/cli doctor --root .
# Runtime: bun 1.4.0
# Native: native (castrum)
# Config: ignex.config.mjs
# Routes: src/routes ✔
# Server: .ignex/server.js not built — run `ignex build`
```

`doctor` exits non-zero on blocking issues, so it runs in CI. When the server
*won't* boot — a bad credential, a missing `.env` value — ignex prints a
configuration-first report with masked secrets and a "what to fix" list,
instead of a driver stack trace:

```
✖ ignex boot failed — plugin "db" could not start

  code     IGN_DB_CREDENTIALS · db · MongoDB
  what     MongoDB rejected the credentials
  retry    no — fix the cause first

  What to fix
    • Check `MONGO_URL` in `.env` — user, password and `authSource` must match the server.
```

## Where to go next

- [Routing](./routing) — every filename convention, plus the interactive
  playground.
- [Examples](/examples/) — complete mini-apps you can copy.
- [Cookbook](./cookbook) — short recipes (sessions, jobs, SSE, i18n…).
- Stuck? `bunx @ignex/cli@latest doctor --root .` is the first command to
  reach for.
