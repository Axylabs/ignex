# CLI reference

See these commands working together end to end in the [tour](./tour).

Everything in ignex is driven by one binary — `@ignex/cli`, fetched on demand
(`bunx @ignex/cli` / `ignex` when installed). Commands are modern interactive
wizards (arrow keys, checkbox multi-select) with **full non-interactive
fallbacks**, so every one stays scriptable.

```sh
ignex --help            # grouped command docs
ignex <command> --help  # one command's full flag reference
ignex --version
```

## Scaffold a project

### `ignex create <app-name>`

Scaffold a new app (wizard + feature toggles). With no arguments it runs the
interactive wizard: project name, package manager, **transport** (HTTPS +
HTTP/2, HTTPS, plain HTTP), and the feature set as checkboxes.

```sh
bun create ignex my-api                        # short form (default features)
bunx @ignex/cli create my-api --features auth,openapi,examples
ignex create api --root ../                    # target an explicit parent dir
ignex create my-api --protocol https2          # HTTPS + HTTP/2 (default: https)
ignex create my-api --features all             # everything wired
ignex create my-api --no-install --no-git      # scriptable
```

Every scaffold ships a **turnkey bootstrap**: `setup.sh` (macOS/Linux) /
`setup.bat` (Windows) installs Bun if missing, then provisions — `.env` from
`.env.example`, dependency install, first build, and a `GET /health` smoke
test. Optional stages: `--docker`, `--caddy`, `--systemd`; `--check` prints a
detection-only JSON report.

### The feature vocabulary

Default set: `openapi,examples,tests` — `all`/`none` accepted. The **same
vocabulary** powers `ignex add`, so you can add any of these to an existing
app later:

| Feature | What lands in your app |
| --- | --- |
| `auth` | `POST /auth/register`, `POST /auth/login`, `GET /auth/me` + `src/lib/auth.ts` (Ed25519 tokens, scrypt hashing, durable SQLite users) + `require-auth` hook |
| `refresh` | + `POST /auth/refresh`, `POST /auth/logout` — hashed, single-use, rotating refresh tokens with replay rejection |
| `sessions` | cookie session plugin + store wiring |
| `cors` `rateLimit` `security` `compression` `logger` | the plugin bundles, wired into `src/app.config.ts` |
| `openapi` | `openapi()` — spec + docs UI at `/openapi` |
| `files` | upload + static-file serving routes |
| `ws` `sse` | WebSocket handler / SSE streaming examples |
| `cache` `proxy` `templates` `i18n` `env` `jobs` | cache helpers, proxy client, server-rendered views, translations, validated env, background jobs |
| `middleware` | `src/middleware/` + lifecycle extension points |
| `metrics` | shared registry + `/metrics` + optional OTLP export |
| `ready` | readiness probe with the 503 contract |
| `durableJobs` | SQLite-backed queue processed by `ignex queue:work` |
| `mailer` | log-driver mailer until SMTP vars are set |
| `realtime` | nova — typed WebSocket pub/sub hub (FlatBuffer wire) |
| `rpc` | typed RPC kit over the hub (pulls `realtime` in automatically) |
| `examples` `tests` | working example routes / a vitest suite |

Production bundles emit their env vars into `src/config/env.ts` +
`.env.example` automatically. Bundle env vars never need hand-wiring.

## Add to an existing app

### `ignex add <feature…>`

Installs the same bundles into the project you're already in — idempotent
(existing files are skipped and reported), `--dry-run` prints the plan,
`--force` overwrites. Plugin/middleware wiring is **additive**: missing
imports and spreads are merged into `src/app.config.ts`; a hand-written
plugin in `src/plugins/index.ts` is preserved.

```sh
ignex add auth                       # auth lib + hook + routes
ignex add auth,refresh               # + rotation/logout
ignex add cors,security,compression  # plugin bundles accumulate
ignex add middleware                 # middleware + lifecycle wiring
ignex add auth --dry-run             # preview, write nothing
ignex add                            # multi-select wizard
```

## Code generation

| Command | What it scaffolds |
| --- | --- |
| `ignex route <path>` | Thin route + `src/modules/` business-logic module (`--no-module` for single-file, `--schema` for TypeBox, `--named` for named exports) |
| `ignex resource <Name>` | Schema-first model + pregenerated CRUD routes (Drizzle/SQL or ninox/Mongo) + migrations config |
| `ignex hotroute <Name>` | Same CRUD, split into thin routes + per-operation modules + hot-cached get-one (`--fields "name:string, price:number"`) |
| `ignex model <Name>` | Schema-first model only (`--fields` DSL: `email:string(format email),age:integer`) |
| `ignex factory <Name>` | Test-data factory for a model |
| `ignex hook <name>` | Named per-route hook (`config = { hooks: ["…"] }`); `--global --stage beforeHandle` registers a lifecycle hook |
| `ignex event <kind> <name>` | Event flows: `sse` (stream + producer module), `webhook` (receiver + handler), `bus` (typed nova contract + plugin + facade + publish route + consumer) |

The `route` two-file shape keeps routes thin from the start:

```
src/routes/products/[id].get.ts      # thin HTTP layer
src/modules/products/[id].get.ts     # business logic (handle(ctx))
```

`ignex event bus` is the realtime scaffold: it writes the wire contract
(`src/realtime.ts`), a pre-wired `novaPlugin`, the typed facade
(`src/lib/events.ts`), a publish route, and an example consumer the compiled
server auto-registers. Re-runs **merge new events into the existing contract**
additively — never overwriting. See
[Realtime](./realtime#scaffolding-a-realtime-feature) for the FlatBuffer wire
and codegen story.

## Dev, build, run

| Command | Behavior |
| --- | --- |
| `ignex dev [root]` | Compile + spawn + watch. Frees a held port (`--kill-port`), restarts crashes with exponential backoff (250 ms → 5 s), stops the old server before spawning the new one (no EADDRINUSE races), tells you when the running server is stale. `--no-spawn` compiles + watches only; `--verbose` prints compiler phase timings |
| `ignex build [root]` | AOT compile → `.ignex/` artifacts. Production-shaped by default (debugbar + tracing eliminated). `--compile --binary-outfile NAME` also emits a standalone Bun executable (runtime embedded, minified, bytecode); `--dev` for a dev-shaped artifact; `--watch` reuses the dev watch flow |
| `bun run start` | Run the compiled server (scaffold script) |

`dev` and `build` print the `Native:` line — `native (castrum)` or
`off (pure-TS fallback)` — so acceleration status is visible at a glance.

## Data

| Command | Purpose |
| --- | --- |
| `ignex migrate <action>` | ninox DB migrations — `create` / `up` / `down` / `status` |
| `ignex seed` | Run (or scaffold) `src/seed.ts` |
| `ignex queue:work` | Process the durable job queue (pairs with `durableJobs`) |
| `ignex schedule:run` | Fire due scheduled jobs |
| `ignex tinker` | REPL against your app's modules |

## Go-live & operations

| Command | Purpose |
| --- | --- |
| `ignex ship` | **Guided go-live**: pick a style (Docker Compose / systemd + Caddy / CI), generate missing artifacts (never clobbering), fill declared secrets into `.env` (generated values), scaffold `/ready`, print a checklist where every row carries its fixing command. `--style systemd --domain api.acme.com --yes` for CI; `--check` re-runs the readiness gate (exit 1 = blocking); `--dry-run` prints the plan |
| `ignex ops <target>` | Generate deployment files: `dockerfile` (multi-stage standalone binary + healthcheck), `compose` (interactive service wizard: MongoDB/Redis/NATS with healthchecks, secrets into `.env.docker`), `caddy` (auto-TLS reverse proxy, `--max-body`, `--lb-retry`), `ci` (GitHub Actions: typecheck/lint/test/build + deploy), `systemd` (hardened units + `deploy/install.sh` + rollback-on-failed-health deploy script), `docker` (all of the above) |
| `ignex doctor [root]` | Health without building: runtime, native addon status, config file, routes dir, compiled server. **Exits non-zero on blocking issues** — CI-safe. `--golive` runs the production pre-flight instead (`.env` present, secrets filled, artifact on disk, `/health` answering, units installed) |
| `ignex info [root]` | Same facts as JSON (includes native status) |

## AI & agents

| Command | Purpose |
| --- | --- |
| `ignex mcp` | Run the Model Context Protocol server (stdio) — connects an AI agent to the [debugbar](./debugbar) of a running app: insights, traces, replay, logs, metrics, leak diagnostics, the KT page. See [AI debugging](./debugbar#ai-debugging-mcp) |
| `ignex route-list [root]` | Machine-readable route inventory |
| `ignex completions <shell>` | Tab-completion script for bash / zsh / fish / PowerShell / cmd — generated scripts call a hidden `ignex _complete` backend, so they always reflect the current command list |

## Where to next

- [Getting started](./getting-started) — the walkthrough that uses these
  commands in order.
- [Debugbar](./debugbar) — the developer dashboard the CLI wires up.
- [Deployment](./deployment) — what `ship` / `ops` generate, end to end.
- Stuck? `ignex doctor` is always the first diagnostic to reach for.
