# Plugins & config

Plugins are plain factories registered in `src/app.config.ts` — no classes,
no global registries, and the compiler reads each plugin's declared context
needs to keep generated code specialized.

## `src/app.config.ts`

```ts
import { compression, cors, requestId, security, session } from "@ignex/core";

export const plugins = [
  requestId(),
  cors(),
  compression(),
  security(),
  session({
    secret: process.env.SESSION_SECRET ?? "dev-secret-change-me",
    createIfMissing: true,
  }),
];

export const server = { port: Number(process.env.PORT ?? 3000) };
```

Everything the framework does is opt-in and visible in one place. The full
built-in catalog: `requestId()`, `cors()`, `compression()`, `security()`,
`session()`, `openapi()`, `rateLimit()`, `logger()`, `csrf()`,
`debugbar()`, `novaPlugin()` (realtime), plus your own.

## Global lifecycle hooks

Cross-cutting logic goes in the `lifecycle` export — stage arrays that run
for every request, compiled down to guarded `if`s (an empty stage costs
nothing):

```ts
export const lifecycle = { beforeHandle: [logRequests(), markResponse()] };
```

Stages: `onStart`, `onRequest`, `onParse`, `onTransform` (before
validation), `beforeHandle`, `afterHandle`, `mapResponse`, `onError`,
`onStop`.

### Per-route hooks

Named hooks resolve from `src/hooks/<name>.ts` — scaffold one with
`ignex hook <name>` — and are listed on the route's `config` export:

```ts
// src/routes/me.get.ts
import { get } from "@ignex/core/http";

export const config = { hooks: ["require-auth"] };

export default get((ctx) => ctx.json({ user: ctx.user }));
```

For inline guards, pass a `before` array in the schema object — each entry
runs in order and may halt with a `Response`:

```ts
export default get(
  (ctx) => ctx.json({ user: ctx.user }),
  { before: [authorize({ permissions: ["profile:read"] })] },
);
```

## Validated environment (`defineEnv`)

Scaffolded apps declare environment variables in a TypeBox schema instead of
reading `process.env` scattered across the codebase:

```ts
// src/config/env.ts
import { Type, defineEnv } from "@ignex/core/env";

export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  DEBUG: Type.Boolean({ default: false }),
  // No default → optional; a missing value logs a warning.
  SESSION_SECRET: Type.Optional(Type.String({ metadata: { secret: true } })),
  // Required — boot fails when unset.
  DATABASE_URL: Type.String(),
});

/** Validated, frozen, fully-typed environment. */
export const env = defineEnv(envSchema);
```

```ts
// src/app.config.ts
import { env } from "./config/env.js";
export const server = { port: env.PORT };
```

Semantics: a `default` fills silently; `Type.Optional(...)` without a
default warns; a required variable missing is a structured boot error.
Mark secrets with `metadata: { secret: true }` — their values are redacted
from every error and report. The scaffold derives `.env.example` from this
schema, so the two can't drift.

## Logging anywhere (global `log`)

Scaffolded apps ship `src/lib/logger.ts` — a global, variadic,
type-aware logger. Pretty and colored in dev, compact JSON in production:

```ts
import { log } from "../lib/logger.js";

log.info("order created", { orderId, total }); // string + JSON fields
log.error(new Error("boom"), "payment failed"); // errors

const reqLog = log.child({ requestId }); // per-request bindings
reqLog.warn("slow query", { ms: 412 });
```

Request-level access logs stay on the `logger()` plugin. When nothing
imports `log`, the bundler drops it from the compiled server.

## The debugbar

A dev-only dashboard served under `/__debugbar/` — register `debugbar()`
in `plugins` (scaffolded apps include it). What it gives you:

- **Waterfall** — every request's spans (middleware, handler, queries) with
  timings.
- **Errors** — the full fault classification from [Errors](./errors):
  origin, kind, code, what-to-fix hints, cause chain, your frame vs the
  dependency's — filterable and searchable.
- **Logs & queries** — everything logged during the request, captured
  without touching your code.
- **History** — SQLite-persisted, so a failure from yesterday is still
  diagnosable today.
- **AI endpoints** — `GET /api/ai/summary` and friends speak MCP, so an
  agent in your editor can read the trace and propose a fix.

**Zero production impact**: `ignex build` eliminates the debugbar, its
observatory stack, and per-request tracing from the artifact — even when
the build shell has no `NODE_ENV`. Pass `--dev` for a dev-shaped build.

## Server config

```ts
export const server = {
  port: Number(process.env.PORT ?? 3000),
  https: true, // default in dev — local certs generated for you
  h2: true, // HTTP/2 over TLS (ALPN), Bun ≥ 1.4.1
  // tls: { certFile: "./cert.pem", keyFile: "./key.pem" },  // your own certs
};
```

- **Dev**: mkcert → openssl generates a locally-trusted certificate, cached
  under `.ignex/certs`. No tools? It warns and falls back to HTTP/1.
- **Prod**: with no `server.tls` configured, ignex warns loudly and serves
  HTTP/1 — TLS is usually terminated at your proxy. Certs are never
  auto-generated in production.
- `IGNEX_HTTPS=0` forces plain HTTP (handy for CI).

The `server` export is typed as `ServerConfig`, so every knob is
discoverable from your editor.
