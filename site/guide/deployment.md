# Deployment

Production is **AOT-only**: the compiled `server.js` (or a standalone
binary) behind a TLS-terminating proxy, scaled horizontally, with shared
state in stores. This page is the practical path; the guided tooling does
most of it for you.

## 1. The artifact

```sh
bun run build      # → .ignex/server.js (+ openapi.json, client.ts, routes.d.ts)
bun run compile    # → also a standalone binary: Bun runtime embedded, bytecode-compiled
./ignex-server     # runs anywhere — no Bun install required
```

`ignex build` is **production-shaped by default**: the debugbar and its
observatory stack are eliminated, dev error pages are pinned off, TLS never
auto-generates dev certificates, and `exposeErrorDetails` defaults to off.
An error that escapes a handler can never leak stack frames.

Behind a proxy, serve plain HTTP/1 and let the proxy own TLS + HTTP/2/3:

```ts
export const server = { port: 3000, https: false }; // IGNEX_HTTPS=0 works too
```

Health check: `GET /health` (the scaffold returns `{ status: "ok" }`).

## 2. The guided flow: `ignex ship`

One command walks you through going live — picks a style, generates what's
missing, fills declared secrets into `.env`, prints a readiness checklist
with the exact fix for every gap:

```sh
ignex ship            # guided; picks Docker Compose / systemd + Caddy / CI
ignex ship --check    # re-run the readiness gate
```

`ignex ops` generates the individual artifacts (`ignex ops caddy`,
`ignex ops systemd`, `ignex ops docker`), and
`bunx @ignex/cli doctor --golive` is the production pre-flight.

## 3. TLS and HTTP/2 at the proxy

Caddy is the recommended default (auto-HTTPS, HTTP/2/3, zero cert
management):

```
example.com {
    reverse_proxy 127.0.0.1:3000
}
```

`ignex ops caddy` generates this (plus systemd units). For HTTP/2 end-to-end
instead, set `server: { https: true, tls: { certFile, keyFile }, h2: true }`
on the app itself — Bun negotiates h2 via ALPN on Bun ≥ 1.4.1.

## 4. Scaling out

ignex is stateless per request — run N instances behind a load balancer:

```sh
PORT=3000 ./ignex-server
PORT=3001 ./ignex-server
```

Or go **same-port, N-processes** with `reusePort` (`SO_REUSEPORT`) — the
kernel spreads connections across replicas, no external LB needed:

```sh
bun run serve:reuseport -- .ignex/server.js 4
```

Shared state moves to stores — see [Data: multi-instance](./data#multi-instance):

| State | Multi-instance backend |
| --- | --- |
| Sessions | Redis store |
| Rate limits | `createRedisRateLimitStore()` — one atomic increment+TTL |
| HTTP cache | `createPersistentHttpCacheStore(redis)` |
| Durable jobs | `openStoreJobStore(createRedisStore(...))` — owner-token leases |
| Realtime presence | nova NATS/Redis cluster |

## 5. Durable jobs and the scheduler in production

Job workers are separate processes (`ignex queue:work`), scheduled jobs run
via `ignex schedule:run` — both coordinate through the job store's atomic
claims, so you can run several workers safely. Deliveries are
at-least-once: keep handlers idempotent.

## 6. Zero-downtime releases

The pattern `ignex ops systemd` generates: build the new artifact to a
staged directory, `systemctl restart` (or `reusePort` replicas rolled one
at a time), Caddy's `--lb-retry` rides out the seconds of restart. Standalone
binaries make rollbacks trivial — keep the previous binary, swap and
restart.

## 7. Kubernetes

`ignex ops` emits manifests; the essentials:

- Probes: `GET /health` (liveness) and `GET /ready` (readiness).
- One container per replica; scale horizontally.
- Terminate TLS at the ingress.
- Run job workers as a separate Deployment sharing the job store.

## The pre-flight checklist

`ignex ship --check` walks this list for you:

- [ ] `bun run build` artifacts present and current
- [ ] `NODE_ENV=production` (or the compiled binary, which pins it)
- [ ] Secrets in `.env` — all required env-schema variables set
- [ ] TLS terminated at proxy (`server.https: false` + Caddy/nginx)
- [ ] `GET /health` answers through the full proxy chain
- [ ] Sessions / rate limits / jobs backed by a shared store (if N > 1)
- [ ] Backups for any SQLite/file state (jobs store, session DB)
- [ ] `ignex doctor --golive` exits zero
