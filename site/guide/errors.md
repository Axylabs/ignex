# Errors

Throw instead of building error responses — ignex maps the throw to the
right status, body, and log line. No `try/catch` adapter layer.

```ts
// src/routes/users/[id].get.ts
import { get } from "@ignex/core/http";
import { ForbiddenError, NotFoundError } from "@ignex/core";

export default get((ctx) => {
  const user = db.users.find(ctx.params.id);
  if (!user) throw new NotFoundError("User not found"); // → 404
  if (!user.visible) throw new ForbiddenError("Not allowed"); // → 403
  return ctx.json({ user });
});
```

## The built-in taxonomy

| Class | status | throw it when |
| --- | --- | --- |
| `BadRequestError` | 400 | the input is wrong |
| `UnauthorizedError` | 401 | credentials are missing or invalid |
| `ForbiddenError` | 403 | authenticated but not allowed |
| `NotFoundError` | 404 | the resource does not exist |
| `ConflictError` | 409 | state conflict / duplicate |
| `ValidationError` | 422 | field-scoped validation failed |
| `TooManyRequestsError` | 429 | a quota was hit |
| `InternalError` | 500 | the framework/app hit a bad state |
| `ApplicationError` | 500 | your own domain logic failed |
| `DBError` | 503 | a datastore or driver failed |
| `UpstreamError` | 502 | an outbound call failed |
| `ConfigError` | 500 | environment/config is wrong |
| `DependencyError` | 500 | a package/addon/binary is missing |

Every class also takes `{ code, kind, retryable, hint, detail, cause }`.
`hint` and `detail` are **operator-only** — they go to the terminal and the
debugger, never to the client:

```ts
try {
  await db.insertOne(doc);
} catch (cause) {
  // the client sees "Database unavailable", operators see the detail
  throw new DBError("insert into gigs failed", { kind: "unreachable", cause });
}
```

## Domain errors: declare once, no mapper, no try/catch

Your services throw their own error classes. Declare the class once with
`defineError` and it *is* an HTTP answer — the framework boundary already
maps it, by convention:

```ts
// src/modules/billing/errors.ts
import { defineError } from "@ignex/core";

// NOT_FOUND → 404, FORBIDDEN → 403, INVALID_STATE → 409 by convention.
export const BillingError = defineError("BillingError");
```

```ts
// src/modules/billing/service.ts
throw new BillingError("invoice not found", "NOT_FOUND");
//           status 404 · code NOT_FOUND · message verbatim
```

```ts
// src/routes/invoices/[id].get.ts — nothing to catch
export default get(async (ctx) => ctx.json(await loadInvoice(ctx.params.id)));
```

The convention covers the codes applications actually use (`NOT_FOUND`,
`FORBIDDEN`, `UNAUTHORIZED`, `DUPLICATE`, `INVALID_STATE`, `EXPIRED`,
`LOCKED`, …). Only the unusual ones need configuring:

```ts
export const CeremonyError = defineError("CeremonyError", {
  codes: { VENUE_CONFLICT: 409, QUOTA_EXCEEDED: 413 },
  fallbackStatus: 422, // any other code
});
```

`createErrorMapper` remains for errors you *can't* change — a driver or
third-party SDK whose status table must live outside the class.

## What you see when something fails

Every 5xx — from a handler, hook, or plugin boot — prints exactly **one**
classified report, redacted and deduplicated:

```
✖ request failed: [ignex] request failed
  code     IGN_DB_CREDENTIALS · db · MongoDB
  what     MongoDB rejected the credentials
  message  Command create requires authentication
  in code  /srv/app/src/routes/api/gigs/index.get.ts:12:5
  request  mb3k4f-1a2 · POST /api/gigs · ip 10.0.0.4
  retry    no — fix the cause first

  What to fix
    • Check `MONGO_URL` in `.env` — user, password and `authSource` must match the server.

  Cause chain (innermost last)
    MongoServerError: Command create requires authentication (code 13)

  Full error and stack: IGNEX_DEBUG=1
```

Read it top-down: the stable **code** (`IGN_DB_CREDENTIALS`) for alerting,
the **`in code`** line that points at *your* frame (source-mapped back from
the bundle), the **`retry`** verdict, and a **what to fix** list derived
from the failure's origin. 4xx responses are never reported — a rejected
request is the caller's fault, not an incident.

## Production vs development: one rule

**4xx is the caller's business, 5xx is ours.**

| Case | Production client sees | Development | Terminal report |
| --- | --- | --- | --- |
| 4xx typed (`NotFoundError`, …) | its message + `code` | same | quiet |
| 5xx typed (`DBError`, …) | `"Service Unavailable"` + code | the real message, redacted | full detail + hints |
| plain `throw new Error("…")` | `"Internal Server Error"` | the message, redacted | classified (still a 500) |

Classification **never changes a status**: only a typed error declares its
own. Credentials are masked everywhere (`mongodb://user:***@host`), and a
5xx whose text was genuinely written for callers can opt in explicitly:

```ts
throw new DBError("read replica is catching up", { message: "Try again shortly", expose: true });
```

## Correlating a failure with a request

Register the opt-in `requestId()` plugin and every report, log line, and
response carries the same id (`request mb3k4f-1a2` in the report above,
`x-request-id` on the wire). In production, identical faults print once per
5-second window with a suppression count — a rejection storm can't flood
your logs.

::: tip The debugger sees the same thing
The dev debugbar renders this exact classification — origin, kind, code,
what-to-fix hints, cause chain, your frame vs the dependency's — in its
Errors view, persisted to SQLite history. See
[Plugins & config](./plugins-and-config#the-debugbar).
:::
