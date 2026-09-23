# Errors

Every failure in ignex — a thrown handler error, a plugin that cannot boot, a
driver that rejects your credentials — is **classified**, **correlated** and
**reported** as one structured thing: a *fault*. This page is the reference for
the taxonomy and for what you see in the terminal.

Design rationale and the exact guarantees live in
[`docs/decisions/013-failure-taxonomy.md`](decisions/013-failure-taxonomy.md).

## Throw a typed error, not a string

```ts
import {
  ApplicationError,
  BadRequestError,
  ConfigError,
  DBError,
  DependencyError,
  NotFoundError,
  RequestError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
} from "@ignex/core";

export default get(async (ctx) => {
  if (!ctx.params.id) throw new BadRequestError("id is required"); // 400 request
  try {
    return ctx.json(await db.findGig(ctx.params.id)); // may return null
  } catch (cause) {
    // 503 db — the client sees "Database unavailable", operators see the detail
    throw new DBError("findGig failed", {
      kind: "unreachable",
      service: "MongoDB",
      collection: "gigs",
      cause,
    });
  }
});
```

| Class | origin | status | retryable | throw it when |
| --- | --- | --- | --- | --- |
| `BadRequestError` / `RequestError` | `request` | 400 | no | the input is wrong |
| `ValidationError` | `request` | 422 | no | field-scoped validation failed |
| `NotFoundError` | `request` | 404 | no | the resource does not exist |
| `ConflictError` | `request` | 409 | no | state conflict / duplicate |
| `TooManyRequestsError` | `request` | 429 | yes | a quota was hit |
| `UnauthorizedError` | `auth` | 401 | no | credentials are missing/invalid |
| `ForbiddenError` | `auth` | 403 | no | authenticated but not allowed |
| `InternalError` | `internal` | 500 | no | the framework/app hit a bad state |
| `ApplicationError` | `app` | 500 | no | your own domain logic failed |
| `DBError` | `db` | 503 | yes* | a datastore or driver failed |
| `UpstreamError` | `network` | 502 | yes | an outbound call failed |
| `ConfigError` | `config` | 500 | no | environment/config is wrong |
| `DependencyError` | `dependency` | 500 | no | a package/addon/binary is missing |

\* `DBError` is retryable by default; a non-retryable `kind` (`credentials`)
wins. Every class also takes `{ code, kind, retryable, hint, detail, details,
cause }` — `hint` and `detail` are **operator-only** and never sent to a client.

## The taxonomy

Two fields describe every fault, and they are what turns "500 Internal Server
Error" into an answer:

- **origin** — which part of the stack broke: `request`, `auth`, `app`,
  `internal`, `config`, `db`, `network`, `dependency`, `native`.
- **kind** — the shape of the failure: `invalid`, `unauthorized`, `credentials`,
  `forbidden`, `missing`, `conflict`, `limit`, `unreachable`, `timeout`, `query`,
  `dependency`, `port`, `aborted`, `unexpected`.

A fault also carries a stable **code** (the error's own code when it has one,
otherwise `IGN_<ORIGIN>_<KIND>` — `IGN_DB_CREDENTIALS`,
`IGN_INTERNAL_UNEXPECTED`), a **retryable** verdict, **hints**, the sanitized
**cause chain**, and — when thrown raw by a driver — the **service**
(`MongoDB`, `PostgreSQL`, …).

You can classify anything yourself:

```ts
import { toFault, renderFault } from "@ignex/core";

const fault = toFault(new Error("connect ECONNREFUSED 127.0.0.1:27017"));
// { origin: "network", kind: "unreachable", code: "IGN_NETWORK_UNREACHABLE", retryable: true, … }
```

Raw throws are read structurally — the `cause` chain, the `code`/`codeName` a
driver attaches, the service markers in the message. **Classification never
changes the status of a plain throw**: an arbitrary `Error` is still a 500. Only
a typed error declares its own status.

A datastore layer with its own typed errors (ninox's `InfraError` /
`DomainError`, a raw `MongoServerError`) is worth wrapping where you catch it, so
the origin is explicit rather than inferred:

```ts
import { ConflictError, DBError } from "@ignex/core";
import { DomainError, InfraError } from "@ignex/ninox";

try {
  await db.insertOne(doc);
} catch (cause) {
  if (cause instanceof InfraError) {
    throw new DBError("insert into gigs failed", { kind: "unreachable", cause });
  }
  if (cause instanceof DomainError) throw new ConflictError(cause.message);
  throw cause;
}
```

## What you see when something fails

Every 5xx — from a handler, a hook or the boot of a plugin — prints exactly one
report per failure:

```
✖ request failed: [ignex] request failed
  code     IGN_DB_CREDENTIALS · db · MongoDB
  what     MongoDB rejected the credentials
  message  Command create requires authentication
  where    /srv/app/src/routes/api/gigs/index.get.ts:12:5
  request  mb3k4f-1a2 · POST /api/gigs · ip 10.0.0.4
  retry    no — fix the cause first

  What to fix
    • Check `MONGO_URL` in `.env` — user, password and `authSource` must match the server.
    • …

  Cause chain (innermost last)
    MongoServerError: Command create requires authentication (code 13)

  Full error and stack: IGNEX_DEBUG=1
```

A boot failure adds a `Configuration check (do this first)` section listing the
`.env` files that exist and the connection variables they define. 4xx responses
are never reported — a rejected request is the caller's fault, not an incident.

## What never leaks

- **Credentials** are masked in every quoted string (`mongodb://user:***@host`,
  `password=***`) — by `redactLogText`, which every report *and* every exposed
  message runs through.
- A report **never dumps the raw object** of a driver error. That is deliberate:
  a `MongoServerError` carries an enumerable BSON graph, and printing it is what
  made a one-line failure unreadable. The `cause` chain is flattened to
  name + message + code.

## Production vs development

The client contract is one rule: **4xx is the caller's business, 5xx is ours.**

| Case | Production client sees | Development (`exposeErrorDetails`) | Log / report |
| --- | --- | --- | --- |
| 4xx typed (`NotFoundError`, `ValidationError`, …) | its message + `code` + `details` | same | not reported (not an incident) |
| 5xx typed (`DBError`, `InternalError`, `ConfigError`, …) | `"Service Unavailable"` / `"Internal Server Error"` + `code` | the real message, redacted | full detail: `message`, `detail`, hints, cause chain |
| plain `throw new Error("…")` | `"Internal Server Error"` + `INTERNAL_ERROR` | the message, redacted | classified report (origin inferred) |
| library-mapped (`statusCode` + `code`) | 4xx message, 5xx generic + its `code` | the real message, redacted | classified report |

```ts
// A 5xx whose text WAS written for callers can opt in explicitly.
throw new DBError("read replica is catching up", { message: "Try again shortly", expose: true });
```

`exposeErrors` defaults to on outside a production build (`ignex build` forces
it off; `--dev` keeps it on), so a developer sees the real failure while a
production client sees a generic phrase plus a machine code it can correlate
with the `x-request-id` header.

### Library errors (ninox, `http-errors`, ORMs)

A third-party error that declares `statusCode`/`status` (400–599) **plus** a
`code` is honoured as typed — its status is used, its `code` keeps the report
traceable (`MONGO_TIMEOUT` → origin `db`, kind `timeout`), and its message is
exposed only for a 4xx or when it sets `expose: true`. No dependency in either
direction; the shape is the contract.

## Report aggregation

In production an identical fault (`code` + message) prints once per 5-second
window, and the next occurrence names how many were suppressed:

```
  (37 identical report(s) suppressed in the last 5s)
```

Development prints every failure. `IGNEX_ERROR_DEDUPE_MS` overrides the window;
`0` disables it.

## Correlating a request with its log line

`ctx.requestId` (and the `x-request-id` response header when tracing is on) is
attached to the report as `request <id>`. The AOT-compiled server passes its
specialized context, so `method`/`path`/`route` appear when the route uses them.

Set `IGNEX_DEBUG=1` to also print the original error object, its properties and
its stack.
