# The tour: one CLI, one dashboard, a whole product

ignex ships two tools you will use every single day: **the `ignex` CLI** —
which scaffolds, generates, builds, diagnoses, and ships — and **the
debugbar**, a full observability dashboard that runs beside your dev server.
Everything else (routes, validation, OpenAPI, the SDK) exists *because of*
what these two do.

This tour is your first hour with a real app. Every command shown is real;
every dashboard panel described is in your browser, not a mockup.

## Minute 0 — a complete app from one command

```sh
bun create ignex my-api --features auth,openapi,examples
cd my-api
bash setup.sh          # installs Bun if missing, provisions, smoke-tests
bun run dev
```

`setup.sh` proves the scaffold works on this machine before you write a
line: it boots the compiled server and polls `GET /health`. You now have
auth-ready config, validated env, a test suite, and HTTPS with a local
certificate.

```
ignex listening on https://localhost:3000
[ignex] openapi: https://localhost:3000/openapi — API docs UI
[ignex] debugbar: https://localhost:3000/__debugbar/ — overview + insights, waterfall + replay, …
```

**Two URLs to bookmark**: `/openapi` (interactive docs for *your* API) and
`/__debugbar/` (your app's dashboard).

## Minute 5 — grow the app with the CLI

Nothing in ignex requires you to write boilerplate by hand. The CLI grows
the app in place, idempotently:

```sh
ignex add auth,refresh          # register/login/me/refresh/logout + guard hook
ignex resource Product --db sql --fields "name:string,priceCents:integer"
ignex event bus chat            # typed realtime contract + hub + consumer
ignex route orders/checkout.post --schema
```

Each command wires what it generates into `src/app.config.ts` and the env
schema — `ignex add metrics` literally writes the `METRICS_*` variables into
`src/config/env.ts` and `.env.example` for you. See the
[CLI reference](./cli) for every command and flag.

## Minute 10 — watch everything in the debugbar

This is the part that changes how you work. Open
`https://localhost:3000/__debugbar/` while the dev server runs:

- **Overview** — the app's control panel: live health, active requests, p95
  latency, and **prioritized findings** with evidence ("this route's p95 is
  1.2s — open the slowest trace", "3 request failures in this window").
- **Requests** — every call with method pills, status badges, and duration
  bars. Click one: the **waterfall** shows each lifecycle stage and every
  query inside it, with idle gaps hatched so you can see what the request
  *waited* on.
- **Errors** — the full fault classification (code, origin, what-to-fix
  hints, cause chain) and a **Replay** button that re-issues the exact
  request through the live server. Debug by reproducing, not by guessing.
- **Logs / Queries / History** — structured logs, every DB statement with
  its timing, and a SQLite archive that survives restarts.
- **System / Diagnostics** — CPU, heap, event-loop charts and leak
  detection with evidence (R²-gated trends, one-click full GC).

And your code joins the trace for free:

```ts
await ctx.debug.query("SELECT …", params, () => db.query(…)); // timed db span
await ctx.debug.span("fetch profile", "http", () => fetch(…));   // any async work
```

### Hand the AI agent the same dashboard

The debugbar speaks **MCP** — the same data your browser shows, an agent in
your editor reads:

```jsonc
{
  "mcpServers": {
    "ignex-debug": {
      "command": "bunx",
      "args": ["@ignex/mcp"],
      "env": { "IGNEX_DEBUGBAR_URL": "http://localhost:3000/__debugbar" }
    }
  }
}
```

The agent calls `debug-summary` → spots a fault → `debug-request` for the
spans → `debug-replay` to reproduce → proposes the fix. No log dumps, no
context pasting. The full tool list is in
[AI debugging](./debugbar#ai-debugging-mcp).

## Minute 30 — the app is real, so check it

```sh
bunx @ignex/cli doctor --root .
```

```
Runtime: bun 1.4.4
Native:  native (castrum)
Config:  ignex.config.mjs
Routes:  src/routes ✔
Server:  .ignex/server.js ✔
```

`doctor` exits non-zero on blocking issues, so the same command gates CI.
When something *did* break — a bad credential, a missing env var — ignex
reports it configuration-first with masked secrets and a what-to-fix list,
in the terminal and in the debugbar, from the same fault object.

## Minute 40 — ship it

```sh
ignex ship                # guided: picks a style, generates artifacts, fills secrets, prints a checklist
ignex ship --check        # re-run the readiness gate (exit 1 = blocking)
ignex ops caddy           # or generate individual pieces: dockerfile / compose / systemd / ci
ignex build --compile     # standalone binary — Bun runtime embedded, no install needed
```

`ignex ship` never clobbers: missing artifacts are generated, your secrets
are untouched, and the printed checklist gives the exact fixing command for
every gap. The [deployment guide](./deployment) is the full topology.

## The kicker: your frontend is already behind

While you built the API, every `ignex build` also emitted `openapi.json`
and a typed client. One more command turns it into an npm package:

```sh
ignex sdk --name @acme/api-sdk        # → typed, zero-dependency fetch client
```

Frontend teams `npm install @acme/api-sdk` and get `api["/products"].get(`
with full autocomplete — generated from the same artifacts the server was
built from, so it cannot drift. See [SDK generation](./sdk).

## The tools, in one table

| You want to… | Command | Guide |
| --- | --- | --- |
| Start an app | `ignex create` / `bun create ignex` | [Getting started](./getting-started) |
| Add auth, sessions, jobs, plugins | `ignex add <features>` | [Auth & sessions](./auth-and-sessions) |
| Generate a full CRUD resource | `ignex resource` / `ignex hotroute` | [CRUD example](/examples/crud-api) |
| Scaffold a route, hook, or model | `ignex route` / `ignex hook` / `ignex model` | [CLI reference](./cli) |
| Add typed realtime | `ignex event bus <name>` | [Realtime](./realtime) |
| See everything the app does | open `/__debugbar/` | [Debugbar](./debugbar) |
| Let an AI agent debug with you | `ignex mcp` + the debugbar URL | [AI debugging](./debugbar#ai-debugging-mcp) |
| Check health | `ignex doctor` | [CLI reference](./cli#go-live-operations) |
| Go live | `ignex ship` / `ignex ops <target>` | [Deployment](./deployment) |
| Ship a typed SDK | `ignex sdk` | [SDK generation](./sdk) |

Next: pick any row and go deeper — or keep following the
[guide path](./getting-started) in the sidebar.
