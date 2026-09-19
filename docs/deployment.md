# Deployment — multi-instance production

How to run an ignex app in production: AOT-only, TLS at the proxy, HTTP/2,
horizontal scaling behind a load balancer, durable jobs/scheduler across
instances, and the realtime (nova) cluster topology.

## 1. AOT-only in production

The AOT-compiled server (`ignex build` → the generated `Bun.serve` entry) is
the production artifact. The interpreted `createApp` path exists for dev and
tests; run the compiled one in prod:

```sh
# Build the deploy artifact (prod-shaped by default)
ignex build

# Or the standalone binary (Bun runtime embedded, minified + bytecode)
ignex build --compile --binary-outfile ignex-server
./ignex-server                      # PORT=3000, HTTPS off by default behind a proxy
```

- **`ignex build` is production-shaped by default**: the debugbar, its
  observatory stack and the per-request tracing instrumentation are eliminated
  at build time, `__IGNEX_PROD_BUILD` is baked in (launching the artifact with
  `NODE_ENV` unset stays locked), TLS never auto-generates dev certificates,
  and `exposeErrorDetails` defaults to `false`. Pass `--dev` for a dev-shaped
  artifact, or set `IGNEX_DEBUG=1` at build time to keep the toolbar in.
- `--compile` builds additionally bake minify + bytecode. The debugbar
  self-disables, the dev error overlay never checks its marker, and
  per-request dev costs are zero.
- TLS is terminated at the proxy (Caddy recommended — see `ignex ops caddy`).
  Set `server.https: false` / `IGNEX_HTTPS=0` behind a proxy so the app
  serves plain HTTP/1 to the proxy, which owns HTTPS + HTTP/2/3.
- Health check: `GET /health` (the scaffolded app returns `{ status: "ok" }`).

## 2. HTTP/2 (and the proxy)

Bun's HTTP/2 is opt-in and requires TLS on the app itself:

```ts
// src/app.config.ts
export const server = {
  port: 3000,
  https: true,           // HTTP/2 requires TLS
  tls: { certFile: "...", keyFile: "..." },  // real certs in prod
  h2: true,
};
```

If TLS is terminated at the proxy (recommended), the proxy negotiates HTTP/2
with clients and speaks HTTP/1.1 (or h2c) to the app — `ignex ops caddy`
generates this by default.

Tuning notes:
- `server.idleTimeout` defaults to 10s (Bun's documented HTTP default) unless
  you set it; keep-alive connections behind a proxy should stay under the
  proxy's idle timeout.
- `server.maxRequestBodySize` defaults to 128 MiB.

## 3. Multi-instance scaling

ignex is stateless per request — scale by running N instances behind a load
balancer:

```sh
# One container per instance; the LB round-robins
PORT=3000 ./ignex-server
PORT=3001 ./ignex-server
```

State that must be SHARED across instances lives in stores:

| State | Default (single instance) | Multi-instance |
| --- | --- | --- |
| Sessions | in-memory / signed cookie | Redis store (`createRedisStore`) via `createStoreManager` |
| Rate limits | in-memory | `createRedisRateLimitStore()` — ATOMIC fixed-window counting across replicas |
| HTTP cache | in-memory | Redis store (fail-open) |
| Durable jobs | file / sqlite | `await openStoreJobStore(createRedisStore(...))` — fresh-read claims + owner-token leases |
| Realtime presence | in-process | nova NATS/Redis cluster (below) |

```ts
// src/db.ts / a store wiring module
import { createRedisRateLimitStore, createRedisStore } from "@ignex/core";
export const redis = createRedisStore({ url: process.env.REDIS_URL });
export const redisLimiter = createRedisRateLimitStore({ url: process.env.REDIS_URL });

// sessions({ store: redis }), rateLimit({ store: redisLimiter }), cache: redis, …
```

### Same port, N processes (`reusePort`)

A single Bun event loop is the ceiling for one process. `reusePort` maps to
`SO_REUSEPORT`, so N processes of the SAME artifact can bind the SAME port and
the kernel spreads accepted connections across them — no external load
balancer, no `cluster` module. It is the cheapest way past the single-loop
ceiling.

```sh
# N processes, one port. Either of these works:

# 1. Helper — spawns + supervises N replicas, forwards SIGINT/SIGTERM, forces
#    IGNEX_REUSE_PORT=1 on each (default entry packages/app/dist/__server.js).
#    The 3rd arg is the child cwd; the reference app needs packages/app so its
#    relative views resolve (`IGNEX_SERVE_CWD` sets it too):
bun run serve:reuseport -- packages/app/dist/__server.js 2 packages/app

# 2. By hand, or under your own supervisor (systemd template, orchestrator):
IGNEX_REUSE_PORT=1 PORT=3000 ./ignex-server &
IGNEX_REUSE_PORT=1 PORT=3000 ./ignex-server &
```

Or declare it once in `src/app.config.ts` (or pass `reusePort: true` to the
compiler — see `packages/compiler/README.md`):

```ts
// src/app.config.ts
export const server = {
  port: 3000,
  reusePort: true,   // SO_REUSEPORT; requires N processes to matter
};
```

Baking `reusePort: true` into the app config (or the compiler option) makes it
unconditional: `IGNEX_REUSE_PORT` can then no longer disable it. The reference
app (`packages/app/src/app.config.ts`) leaves the field unset so the runtime env
stays authoritative.

Precedence, highest first:

1. the compiler build option `reusePort: true` (baked as a literal);
2. `server.reusePort` in the runtime app config;
3. `IGNEX_REUSE_PORT=1` (or any other value — only `1` enables it).

**Requires N processes.** A SINGLE process gains nothing from `reusePort` — the
flag is only useful when several processes share the port. Run at least 2, and
keep the count at or below a small multiple of the core count (beyond that the
kernel's spreading plus per-process state makes it host-dependent). The shared
castrum/ignex measurement saw **+66–78% RPS and roughly half the p50 at 2
processes**.

**Per-process state is not shared.** Each replica has its own in-memory rate
limiter, session store, and HTTP cache, so N processes give each client N× the
configured limit unless the backing store is shared (see the table above).
Externalize rate-limit/session/cache state before scaling out. Workers/scheduler
processes (`queue:work`, `schedule:run`) are unaffected — run them as usual.

Use an external supervisor to keep N replicas alive: a container orchestrator
(`replicas: N` with the same port and `reusePort` on), a systemd template unit,
or a small `Bun.spawn` loop. Health/readiness probes are unchanged — each
replica answers them independently.

### Readiness vs liveness

`GET /health` is LIVENESS: it never touches dependencies (a dead DB must not
cause a restart loop). For LOAD BALANCER routing use readiness:
`healthProbe({ readiness: [...] })` registers `/ready` on interpreted apps,
and AOT apps ship a `src/routes/ready.get.ts` file route running the same
checks via `runReadinessChecks()`. A failing check returns **503**, so a
replica with a dead MongoDB stops receiving traffic instead of serving errors.

`ignex ops compose` scaffolds the infra (MongoDB/Redis/NATS) + `.env.docker`.

## 4. Durable jobs & the scheduler across instances

`ignex queue:work` and `ignex schedule:run` are worker processes; run as many
as you need. Every job operation performs a FRESH read-modify-write against
the store (no stale snapshots), claims stamp a random **owner token**, and
completion/heartbeat bookkeeping verifies ownership — the loser of any race
cannot double-run or double-complete someone else's job:

```sh
# systemd / container: one app + N workers + 1 scheduler (or N schedulers)
./ignex-server
ignex queue:work          # claim loop (run 2+ for throughput)
ignex schedule:run        # cron ticks → durable jobs (run 1+, safe to duplicate)
```

- Multiple replicas never double-CLAIM (fresh reads see another worker's
  `running` stamp) and cannot double-COMPLETE (owner tokens). The residual
  last-writer-wins window of a single-key store is narrowed but not
  eliminated — for strict exactly-once at high concurrency, back the queue
  with a store that has native atomic ops (Redis Lua / SQL row updates) via a
  custom `JobStore`.
- A crash mid-job is recovered by lease expiry: the job is re-queued and
  picked up by another worker. At-least-once — handlers should be idempotent.
- Completed/failed history grows without bound unless bounded: configure
  `retention` on the job store (`createFileJobStore(dir, { retention: { maxAgeMs, maxCompleted } })`)
  to prune finished jobs.
- Rate-limit stores can fail OPEN or CLOSED per deployment posture:
  `rateLimit({ store, onStoreError: "closed" })` returns 503 when Redis is
  unreachable instead of silently disabling protection (default `"open"`
  allows and logs once).

## 5. Realtime (nova) cluster topology

`novaPlugin` serves typed pub/sub over WebSockets. Horizontally:

```
                ┌────────── LB / Caddy (wss) ──────────┐
                │                                       │
         instance A (nova)                      instance B (nova)
                │          NATS (or Redis)             │
                └──────────────┬───────────────────────┘
                               │
                        ignex.broadcast.* / ignex.topic.* / ignex.group.*
                        + ignex.inbound.> (external apps push events in)
```

- Each instance's nova server bridges every publish to NATS using the SAME
  FlatBuffer wire frame (`ignex.broadcast.*`, `ignex.topic.*`,
  `ignex.group.*`); other instances consume and fan out to their local
  sockets — one logical hub across N processes.
- External apps (workers, cron, other services) push events into the hub via
  `ignex.inbound.>` and the server forwards them to clients — no WebSocket
  connection needed to emit.
- `bridgeClientEvents: true` re-publishes client-sent events to the cluster
  (horizontal chat/rooms).
- Presence + shared-state indexes: enable the events layer's cluster sync
  (`events: { cluster: { nats: true } }` or Redis) so `emitToUser` /
  `clientsByUser` / user groups work across instances.
- `maxConnections` / `maxMessageSize` / backpressure are per-instance; keep
  them uniform across replicas so the LB distributes fairly.

```ts
// src/app.config.ts
import { jwtAuth, novaPlugin } from "@ignex/core";

export const plugins: IgnexPlugin[] = [
  novaPlugin({
    port: 3001,
    inbound: ["chat"],
    authenticate: jwtAuth({ secret: env.JWT_SECRET }),
    nats: { servers: ["nats://nats:4222"], inbound: true, bridgeClientEvents: true },
  }),
];
```

WebSocket clients connect to any instance (`ws://…/ws` — the LB should
support sticky sessions OR the cluster handles cross-instance delivery; with
the NATS bridge, stickiness is not required for correctness, only efficiency).

## 6. Observability in production

```ts
import { metricsPlugin, createOtlpExporter } from "@ignex/core";

const metrics = createMetrics();
export const plugins: IgnexPlugin[] = [
  metricsPlugin({ path: "/metrics", token: env.METRICS_TOKEN, metrics }),
  // ...
];

// after createApp:
const otlp = createOtlpExporter(metrics, { endpoint: env.OTLP_ENDPOINT });
otlp.start();            // push on an interval (stop() on shutdown)
```

- `GET /metrics` → Prometheus text format (per-route request counts +
  duration histograms). Protect it with a token or the proxy.
- Access logs: the `logger` plugin emits structured pino lines
  (`requestId/method/path/route/status/durationMs/ip`).
- App logs: scaffolded `src/lib/logger.ts` gives every route/hook/service a
  variadic global `log` (`log.info("order", { orderId })`) — pretty ANSI
  output in development, pino JSON in production. Set `LOG_LEVEL`
  (`debug|info|warn|error`) once — access and app logs honor it together.
- The debugbar is DEV-ONLY; it self-disables in production and its per-request
  cost is a single boolean check.

## 7. Graceful shutdown & rolling deploys

The generated server handles SIGTERM/SIGINT: stop accepting, drain active
requests (`server.stop(true)`), close plugin resources (DB connections,
stores, nova hub), then exit (10s hard deadline). Send SIGTERM and wait —
containers / systemd / the LB drain naturally. `queue:work` / `schedule:run`
drain the same way.

## 8. Reference: `ignex ops`

| Command | Emits |
| --- | --- |
| `ignex ops dockerfile` | Dockerfile + .dockerignore (multi-stage, standalone binary) |
| `ignex ops compose` | docker-compose.yml + .env.docker (MongoDB/Redis/NATS) |
| `ignex ops caddy` | Caddyfile (TLS, HTTP/2/3, `/health` probe) |
| `ignex ops ci` | CI workflow that builds + tests the container |

See also: [docs/sdk.md] (distributing the typed client), [docs/stability.md]
(risk register + gates), [docs/cookbook.md] (recipes), [docs/architecture.md]
(package layout + the AOT contract).
