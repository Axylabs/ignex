# Auth & sessions

ignex ships a complete auth stack as scaffold features — not a plugin
ecosystem you have to assemble. Ed25519 access tokens, portable password
hashing (scrypt by default, native Argon2id by explicit choice), a durable
SQLite user store, session management, and the hooks that glue them to
routes.

## The one-command way

```sh
ignex add auth            # auth lib + require-auth hook + register/login/me routes
ignex add auth,refresh    # + durable hashed refresh tokens with rotation
ignex add sessions        # cookie sessions with any store backend
```

Or at scaffold time:

```sh
bun create ignex my-api --features auth,refresh,sessions
```

What lands in your app:

- `src/lib/auth.ts` — token issuing/verification and password hashing
- `src/routes/auth/{register,login,me,logout,refresh}.post.ts` — the flow
- `src/hooks/require-auth.ts` — the guard you attach per route
- `.env` entries (`JWT_SECRET`, …) wired through the validated env schema

New registrations always receive the `user` role; role administration
belongs in a separate authorized flow you write. Production key bootstrap
**fails closed** rather than writing private keys into `.env`.

## Guarding a route

```ts
// src/routes/me.get.ts
import { get } from "@ignex/core/http";

export const config = { hooks: ["require-auth"] };

export default get((ctx) => ctx.json({ user: ctx.user }));
```

The `require-auth` hook verifies the bearer token and attaches the claims
to `ctx.user` — a missing or invalid token short-circuits with `401`
before your handler runs.

For permission-scoped guards, use the inline `before` form:

```ts
export default get(
  (ctx) => ctx.json({ user: ctx.user }),
  { before: [authorize({ permissions: ["profile:read"] })] },
);
```

## Tokens and refresh

The default flow is Ed25519-signed JWT access tokens. Adding `refresh`
gives you **hashed, durable, single-use refresh tokens** with rotation and
replay rejection — a stolen refresh token from an already-rotated session
is rejected, not honored.

```sh
curl -X POST https://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email": "ada@example.com", "password": "••••••"}'
# → { accessToken, refreshToken, user: { … } }
```

## Sessions

Prefer opaque server-side sessions? The `session()` plugin handles it, with
the store backed by any [driver](./data#stores-one-contract-many-backends) —
memory in dev, SQLite or Redis in production:

```ts
import { get } from "@ignex/core/http";
import { getSession } from "@ignex/core";

export default get(async (ctx) => {
  const session = await getSession(ctx);
  if (!session) return ctx.json({ session: null });

  const visits = ((session.data.visits as number | undefined) ?? 0) + 1;
  session.data.visits = visits;
  await session.save();

  return ctx.json({ id: session.id, visits, isNew: session.isNew });
});
```

Register it in `src/app.config.ts`:

```ts
session({
  secret: env.SESSION_SECRET,
  createIfMissing: true,
  // store: createSessionStoreFromStore(sqliteStore),  // multi-instance ready
}),
```

::: warning Multi-instance deployments
In-memory sessions and in-memory rate limits break the moment you run more
than one process. Back them with a shared store — see
[Data: multi-instance](./data#multi-instance) and
[Deployment](./deployment).
:::

## CSRF

If you use cookie auth from browsers, register `csrf()` in the plugins
array — it rejects state-changing requests that don't carry the matching
token. Pure bearer-token APIs don't need it.

## What about roles and RBAC?

Keep roles as data on your user, guard with `authorize(...)` checks, and
administer them through a dedicated authorized flow. ignex deliberately
doesn't ship a roles UI — it ships the primitives (`ctx.user`,
`authorize`, typed errors) that make the 20 lines you need trivial.
