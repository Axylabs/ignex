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

## SQL resources (Drizzle)

For SQL, ignex wraps the **standard approach** — [Drizzle](https://orm.drizzle.team)
— with the same CLI surface as the Mongo path:

```sh
# Scaffold a User model + CRUD routes + drizzle.config.ts + src/db-sql.ts
ignex resource User --db sql --fields "email:string(format email),age:integer,active:boolean"

# Migrations via drizzle-kit (generate/push/check)
ignex migrate create add-profile --db sql    # drizzle-kit generate
ignex migrate up --db sql                    # drizzle-kit push
```

What you get (Mongo and SQL share the route contract and field DSL):

- `src/models/users.ts` — a typed drizzle sqlite table (`$inferSelect` /
  `$inferInsert`). Field mapping: `string→text`, `integer→integer`,
  `number→real`, `boolean→integer(mode boolean)`, `date→integer(timestamp_ms)`,
  `array/enum/objectId→text`.
- `src/db-sql.ts` — the shared client (`bun:sqlite`, WAL). Swap the driver for
  Postgres by changing one import.
- `src/routes/api/users/*` — list/getOne/create/update/delete backed by drizzle
  queries (`select/insert/update/delete` + `eq`), validated with TypeBox.
- `drizzle.config.ts` — drizzle-kit config pointing at `src/models/*.ts`.

The storage is file-backed SQLite (zero-config); `DATABASE_URL` overrides the
path. This is intentionally **not** a new ORM — it's Drizzle with ignex-shaped
DX (same `--fields` DSL, same route layout, same `ignex migrate`).

## Validation & OpenAPI

```ts
// src/routes/products/[id].get.ts
import { get } from "@ignex/core/http";
import { Type } from "typebox";

export default get(
  {
    params: Type.Object({ id: Type.String() }),
  },
  (ctx) => ctx.json({ id: ctx.params.id }),
);
```

### FormRequest-style validation (`defineRequest`)

Bundle a schema, its request part, and an optional authorization gate into a
reusable object — the Laravel FormRequest pattern, sugar over the existing
Standard-Schema validation:

```ts
// src/requests/create-user.ts
import { defineRequest } from "@ignex/core";
import { Type } from "typebox";

export const CreateUser = defineRequest({
  part: "body", // body | query | params | headers
  schema: Type.Object({
    email: Type.String({ format: "email" }),
    role: Type.Optional(Type.Union([Type.Literal("admin"), Type.Literal("user")])),
  }),
  // optional: 403 when false (runs before validation)
  authorize: (ctx) => ctx.state.user?.role === "admin",
});
```

```ts
// in a route
export default post(async (ctx) => {
  const input = await CreateUser.validate(ctx); // 422 with per-field errors
  return ctx.json(input, { status: 201 });
});
```

Schemas are precompiled to standalone validators/serializers at build time and
flow into the generated `openapi.json`. Serve it — plus a docs UI — with the
`openapi()` plugin:

```ts
// src/app.config.ts
import { openapi } from "@ignex/core";

export const plugins = [
  // ...
  openapi({ documentation: { title: "my-api", version: "0.1.0" } }),
];
```

- `GET /openapi.json` — the OpenAPI 3.1 document. In AOT builds it serves the
  compiler-generated `openapi.json` artifact (the **newest** candidate among
  `artifactPath` and the `.ignex`/`dist` defaults is used, so dev regeneration
  is always picked up — even while the server stays running); in interpreted
  `createApp` apps it enumerates the router's routes at request time.
- `GET /openapi` — Scalar docs UI (`provider: "swagger-ui"` for Swagger-UI,
  `provider: null` for spec-only).

Paths are configurable via `path` / `specPath`; routes can be excluded with
`exclude`, and per-route metadata (`summary`/`tags`/`hide`/…) via `detail`
(interpreted: in the route schema object; AOT: `export const config = { detail }`).

Operations are **auto-grouped into tags by their first path segment**
(`/api/orders` → `api`, `/auth/login` → `auth` — mirroring the `routes/`
folder layout) so docs UIs render collapsible resource groups; a top-level
`tags` array is derived from the operations. An explicit `detail.tags` (even an
empty array, meaning "no tags") overrides the auto-tag for that route.

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

### HTTPS by default

`server.https` defaults to `true`, so ignex enables TLS at startup:

- **Development** auto-generates a local certificate (mkcert → openssl
  fallback), caches it under `.ignex/certs`, and logs where it came from.
  No tools available? It warns and **falls back to HTTP/1**.
- **Production** with no `server.tls` warns loudly and falls back to HTTP/1 —
  TLS is usually terminated at your proxy (nginx/Caddy/Cloudflare). Certs are
  never auto-generated in production.

```ts
export const server = {
  port: Number(process.env.PORT ?? 3000),
  https: true,                            // default; serve HTTPS (TLS)
  h2: true,                               // opt-in HTTP/2 (requires TLS)
  tls: { certFile: "./cert.pem", keyFile: "./key.pem" }, // your own certs
};
```

- Force plain HTTP/1: `server.https: false`, or `IGNEX_HTTPS=0` for CI/tooling.
- TLS serves HTTP/1.1 by default. Opt into **HTTP/2** with `server.h2: true`
  (compiled and interpreted paths both forward it to `Bun.serve`). HTTP/3 is
  still not available from `Bun.serve`, so for h3 put **Caddy** in front — it
  auto-provisions real certs (Let's Encrypt) and terminates h2/h3 for clients
  while proxying to Bun:

  ```caddyfile
  example.com {
      reverse_proxy 127.0.0.1:3000
  }
  ```

### Standalone production binary

`ignex build --compile` (or `bun run compile`) emits a self-contained
executable — Bun runtime embedded, bytecode-compiled, minified, with linked
sourcemaps and `NODE_ENV=production` inlined:

```sh
ignex build --compile --binary-outfile my-server   # → outDir/my-server (or .exe on Windows)
./my-server                                        # no Bun install required
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

## Typed realtime events (@ignex/nova)

For typed pub/sub over WebSockets — rooms, groups, per-user delivery, NATS
cluster sync, and a Rust FFI serializer — use the `novaPlugin` bridge. The
events layer (`on`/`emit`/`emitToUser`) is **enabled by default**; for your
own event names pass the generated `bindings` (from `src/realtime.ts`):

```ts
// src/realtime.ts — the wire contract (single source of truth)
import { Type } from "@sinclair/typebox";
export const realtime = {
  subjectPrefix: "myapp",
  events: {
    "chat.message": Type.Object({ to: Type.String(), body: Type.String() }),
  },
};
```

```ts
// src/app.config.ts
import { jwtAuth, novaPlugin } from "@ignex/core";
import { bindings } from "../.ignex/sdk/realtime/index.js"; // generated

export const plugins: IgnexPlugin[] = [
  novaPlugin({
    port: 3001,                 // the WS server port
    path: "/ws",
    bindings,                   // custom event registry (from src/realtime.ts)
    // Bridge nova's WS auth to the app's JWT hook: the resolved claims become
    // the client record (id / userId / groups / meta) the events layer uses.
    authenticate: jwtAuth({ secret: env.JWT_SECRET }),
    // Optional: cluster sync across instances (needs NATS running).
    // nats: { servers: ["nats://localhost:4222"] },
  }),
];
```

Regenerate the local SDK (bindings + typed client + server facade) with
`ignex build` (auto) or `ignex sdk --platform realtime`:

```ts
// anywhere in the app — typed emit / handle (no casts)
import { emitToUser, on } from "./lib/events.js"; // re-exports the SDK facade

on("chat.message", (payload, ctx) => {
  emitToUser(payload.to, "chat.delivered", { id: payload.id });
});

// from a route or job:
emitToUser("u-42", "order.update", { orderId: "o-1" });
```

- **Clients** (browser + Bun): `createRealtimeClient("ws://host:3001/ws")`
  from the generated SDK — `client.on("quote", cb)` / `client.send("chat", …)`
  are typed against YOUR events; decode is pure JS (FlatBuffers), no FFI.
- **Scaffold**: `ignex event bus <name>` emits `src/realtime.ts`, a pre-wired
  `src/realtime.plugin.ts`, a publish route, and an example consumer — it also
  updates `tsconfig` include and generates the local SDK (offers to install
  `@ignex/nova`; codegen needs `flatc` on PATH).
- Install: `bun add @ignex/nova` (+ `@sinclair/typebox` for the contract).

## Mail & notifications

`createMailer` wraps a standard driver (built-in `log` driver for dev/tests;
`nodemailer` SMTP driver opt-in) — never a new SMTP stack. `createNotifier`
pushes typed events to a user's sockets via `@ignex/nova` with an email
fallback for offline users.

```ts
import { createMailer, createNotifier } from "@ignex/core";

// dev: log driver (no SMTP needed); prod: swap to { driver: "smtp", smtp: {...} }
const mailer = createMailer();

const notify = createNotifier({
  mailer,
  // name → email subject (sends a fallback email when the user is offline)
  emailSubjects: { "order.update": "Your order changed" },
});

// realtime push to u-42's sockets (via @ignex/nova) + fallback email
await notify.user({ id: "u-42", email: "user@example.com" }, "order.update", {
  orderId: "o-1",
});

// send a raw email (log driver writes to console)
await mailer.send({ to: "x@y.z", subject: "Hi", text: "body" });
```

The mailer never throws on the request path — pair `send` with a durable job
(`queue.enqueue({ name: "send-email", payload })`) for reliable delivery.

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

### Validated env config (TypeBox) — recommended

Every new project ships `src/config/env.ts` (via `ignex create`): a TypeBox
schema that declares which environment variables are required, optional, and
secret, with sensible defaults. Reading `process.env` directly is discouraged —
the schema validates at boot and produces structured errors/warnings.

```ts
// src/config/env.ts
import { Type, defineEnv } from "@ignex/core/env";

export const envSchema = Type.Object({
  NODE_ENV: Type.String({ default: "development" }),
  PORT: Type.Integer({ default: 3000, minimum: 1, maximum: 65535 }),
  LOG_LEVEL: Type.Union(
    [Type.Literal("debug"), Type.Literal("info"), Type.Literal("warn"), Type.Literal("error")],
    { default: "info" },
  ),
  DEBUG: Type.Boolean({ default: false }),
  // No default → optional; a missing value logs a warning and the type is
  // `string | undefined` (see src/app.config.ts for the dev fallback).
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

Semantics:

| Schema                                          | Missing var              | Static type            |
| ----------------------------------------------- | ------------------------ | ---------------------- |
| `Type.String()`                                 | error (`IGN_ENV_MISSING_REQUIRED`) | `string`     |
| `Type.String({ default: "x" })`                 | default filled, no warning | `string` (non-null)   |
| `Type.Optional(Type.String({ default: "x" }))`  | default filled, no warning | `string \| undefined` |
| `Type.Optional(Type.String())`                  | warning (`IGN_ENV_MISSING_OPTIONAL`) | `string \| undefined` |

A `default` makes a variable optional. Prefer the non-`Optional` form to keep
the resolved type non-null. Mark secrets with `metadata: { secret: true }` —
their values are redacted from errors, warnings, and the report.

- `defineEnv` loads `.env`/`.env.local` first (existing env wins), applies
  defaults and string coercion (`"8080"` → `8080`, `1/yes/on` → `true`, JSON
  arrays/objects), throws a structured `EnvError` on invalid or missing
  required variables, and warns (via `console.warn` or `onWarning`) about
  unset optional variables without a default. `strict: true` upgrades warnings
  to errors; `loadEnv: false` skips dotenv loading.
- `validateEnv(schema, { source })` never throws — it returns
  `{ ok, value, issues }` for tooling, tests, and CI.
- `envExampleFromSchema(schema)` renders a `.env.example` from the schema so
  the two stay in sync; the scaffold already generates one for you.
- `ignex doctor` reports env errors/warnings; `ignex dev` / `ignex build`
  print non-blocking pre-flight warnings.

The `.env.example` generated by the scaffold looks like:

```bash
# Copy to .env and adjust:   cp .env.example .env

# OPTIONAL — NODE_ENV (default: development)
NODE_ENV=development

# OPTIONAL · secret — SESSION_SECRET
SESSION_SECRET=

# REQUIRED — DATABASE_URL
DATABASE_URL=your-value
```

### Typed accessors & `defineConfig` (legacy)

The original accessors remain available for one-off reads:

```ts
import { get } from "@ignex/core/http";
import { env, loadEnv } from "@ignex/core";

loadEnv();

export default get((ctx) =>
  ctx.json({ direct: env("SOME_VAR", "fallback") }),
);
```

Typed accessors: `env`, `envInt`, `envBool`, `envFloat`, `envJson`, `envSecret`;
`defineConfig` still supports the older field-style schema.

## Generated client

```ts
import { createClient } from "@ignex/core";

const api = createClient("http://localhost:3000");
const res = await api.products.get({ params: { id: "123" } }); // typed from client.ts
```

`client.ts` is regenerated on every build with types derived from your routes
and schemas.
