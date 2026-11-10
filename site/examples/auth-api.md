# Auth API

Register, login, and a guarded `/me` — the complete flow, generated for you
by `ignex add auth`. You write almost no code; you write the *routes that
use* it.

**You'll need**: a dev server, and one command:

```sh
ignex add auth,refresh
# → src/lib/auth.ts, src/hooks/require-auth.ts,
#   src/routes/auth/{register,login,me,logout,refresh}.post.ts,
#   JWT_SECRET wired into src/config/env.ts + .env.example
```

## The generated flow

| Route | What it does |
| --- | --- |
| `POST /auth/register` | create account (scrypt-hashed password) → tokens |
| `POST /auth/login` | verify credentials → tokens |
| `GET /auth/me` | guarded — the current user's claims |
| `POST /auth/refresh` | rotate the refresh token (hashed, single-use) |
| `POST /auth/logout` | revoke the session's refresh token |

Try it:

```sh
curl -k -X POST https://localhost:3000/auth/register \
  -H 'content-type: application/json' \
  -d '{"email": "ada@example.com", "password": "correct horse battery"}'
# → { "accessToken": "…", "refreshToken": "…", "user": { "id": "usr_1", "role": "user" } }
```

::: warning Roles
New registrations always receive the `user` role. Role administration is a
separate authorized flow you write — the framework doesn't guess.
:::

## Guarding your own routes

The generated `require-auth` hook verifies the bearer token and attaches
claims to `ctx.user`:

```ts
// src/routes/me.get.ts
import { get } from "@ignex/core/http";

export const config = { hooks: ["require-auth"] };

export default get((ctx) => ctx.json({ user: ctx.user }));
```

```sh
curl -k https://localhost:3000/me -H 'authorization: Bearer <accessToken>'
# → { "user": { "id": "usr_1", "email": "ada@example.com", "role": "user" } }

curl -k https://localhost:3000/me
# → 401 { "error": "Unauthorized", "code": "IGN_AUTH_UNAUTHORIZED" }
```

## Permission-scoped guards

For finer checks, use an inline `before` guard instead of (or alongside)
the hook:

```ts
// src/routes/admin/stats.get.ts
import { get } from "@ignex/core/http";

export default get(
  (ctx) => ctx.json({ uptime: process.uptime() }),
  { before: [authorize({ permissions: ["admin:read"] })] },
);
```

A failed guard is a typed `403 ForbiddenError` — same error pipeline as
everything else, so the client gets a clean envelope and the debugbar gets
a classified fault.

## Why refresh tokens are safe here

With `,refresh` installed, refresh tokens are **hashed before storage,
single-use, and rotated on every refresh** — a token that was already
rotated is rejected as a replay. They live in a durable SQLite store, so
server restarts don't log users out. Production key bootstrap **fails
closed** rather than silently writing private keys into `.env`.

## Adding cookie sessions instead

Bearer tokens are the default; cookie sessions are one command away and
compose with the same guard story — see
[Auth & sessions](../guide/auth-and-sessions#sessions). If browsers call
your API cross-origin, also register `csrf()`:

```ts
// src/app.config.ts
export const plugins = [/* … */ csrf()];
```

## What to notice

- **The auth code isn't yours to maintain** — hashing, tokens, rotation,
  and replay rejection are framework-tested.
- **The guard is one line per route** — and it runs *before* your handler,
  compiled into the route's guarded chain.
- **Errors flow through the same taxonomy** — 401/403 are typed, correlated
  in logs, and quiet by design (4xx is the caller's business).

Next: [Realtime chat](/examples/realtime-chat) — stream events and add a
typed chat bus.
