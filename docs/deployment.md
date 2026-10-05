# Deployment — multi-instance production

How to run an ignex app in production: AOT-only, TLS at the proxy, HTTP/2,
horizontal scaling behind a load balancer, durable jobs/scheduler across
instances, the realtime (nova) cluster topology, Kubernetes manifests, backups /
disaster recovery, and zero-downtime releases.

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
  `NODE_ENV` unset stays locked), Bun's dev error page is pinned off
  (`development: false` — an error that escapes the request wrapper can never
  leak stack frames or source lines), TLS never auto-generates dev
  certificates, and `exposeErrorDetails` defaults to `false`. Pass `--dev` for
  a dev-shaped artifact, or set `IGNEX_DEBUG=1` at build time to keep the
  toolbar in.
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
- `server.maxRequestBodySize` defaults to 64 MiB (`DEFAULT_MAX_REQUEST_BODY_SIZE`
  — a deliberate ceiling, not Bun's larger implicit default).

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

The generated server handles SIGTERM/SIGINT with the same contract as
`createApp().serve()` (both delegate to `installGracefulShutdown`):

1. the first signal stops accepting new connections and **awaits the drain** —
   `server.stop(false)` resolves once in-flight requests have finished (idle
   keep-alive connections do not hold it open);
2. plugin resources (DB connections, stores, nova hub) close **after** the
   drain, so a handler still running never finds its dependency torn down;
3. the process then exits `0`.

Send SIGTERM and wait — containers / systemd / the LB drain naturally.
`queue:work` / `schedule:run` drain the same way.

The failure paths are explicit, so a wedged request can never hold a deploy
hostage: a **second** signal, or the 10s deadline elapsing, forces `exit(1)`
with a log line, and a drain that rejects also exits `1`. Only a *completed*
drain exits `0` — so a supervisor (or Kubernetes) can tell a clean stop from a
forced one.

**WebSocket apps** are the exception: Bun cannot selectively drain sockets, so
`stop(false)` would wait on connections that never close. A server with any
`.ws.ts` route calls `stop(true)` instead — terminating sockets and in-flight
requests immediately — and relies on the deadline. If you need lossless HTTP
drains *and* realtime sockets, run them as separate deployments.

Startup failures are reported the same way as request failures: a bind error
(the usual `EADDRINUSE`) prints a classified block (`IGN_INTERNAL_PORT`, "the
listen port is already in use", with what to fix) and exits `1`, rather than
dying with a raw stack — see `docs/errors.md`.

## 8. Kubernetes

A production-shaped set of manifests for the compiled binary (the image has no
runtime to install — see `ignex ops dockerfile`). Apply with `kubectl apply -f`,
creating the `ignex-secrets` Secret separately (never in git; the hardening
checklist in [SECURITY.md](../SECURITY.md) applies here too).

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: ignex-app
spec:
  replicas: 3
  selector:
    matchLabels: { app: ignex-app }
  strategy:
    type: RollingUpdate
    rollingUpdate: { maxUnavailable: 0, maxSurge: 1 }   # zero-downtime roll
  template:
    metadata:
      labels: { app: ignex-app }
    spec:
      terminationGracePeriodSeconds: 30                  # MUST exceed the 10s drain deadline
      containers:
        - name: app
          image: ghcr.io/OWNER/ignex-app:latest
          ports: [{ containerPort: 3000 }]
          env:
            - name: PORT
              value: "3000"
            - name: IGNEX_HTTPS
              value: "0"                                  # TLS terminates at the ingress
            - name: MONGO_URL
              valueFrom: { secretKeyRef: { name: ignex-secrets, key: mongo-url } }
            - name: REDIS_URL
              valueFrom: { secretKeyRef: { name: ignex-secrets, key: redis-url } }
            - name: JWT_SECRET
              valueFrom: { secretKeyRef: { name: ignex-secrets, key: jwt-secret } }
          livenessProbe:
            httpGet: { path: /health, port: 3000 }        # never touches dependencies
            periodSeconds: 10
          readinessProbe:
            httpGet: { path: /ready, port: 3000 }         # 503 while a dependency is down
            periodSeconds: 5
          resources:
            requests: { cpu: "250m", memory: "256Mi" }
            limits: { memory: "512Mi" }
```

```yaml
# service.yaml
apiVersion: v1
kind: Service
metadata:
  name: ignex-app
spec:
  selector: { app: ignex-app }
  ports: [{ port: 80, targetPort: 3000 }]
---
# hpa.yaml — requires metrics-server
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: ignex-app
spec:
  scaleTargetRef: { apiVersion: apps/v1, kind: Deployment, name: ignex-app }
  minReplicas: 3
  maxReplicas: 12
  metrics:
    - type: Resource
      resource: { name: cpu, target: { type: Utilization, averageUtilization: 70 } }
```

What matters more than the YAML:

- **`replicas > 1` requires externalized state.** Sessions, rate limits, the HTTP
  cache and durable jobs must live in Redis/the shared store (§3). Otherwise each
  pod enforces its own quota and one client gets N× the configured limit.
- **Probe the two endpoints differently.** `/health` failing restarts the pod;
  `/ready` failing only removes it from the Service. Wiring a DB check into
  `/health` turns a brief database outage into a restart loop.
- **`maxUnavailable: 0` plus a grace period longer than the drain deadline** is
  what makes a rollout lossless: the pod gets `SIGTERM`, drains
  (`server.stop(true)`), closes plugin resources, then exits. A grace period
  SHORTER than the drain truncates in-flight requests.
- **WebSockets (nova):** if you rely on sticky sessions add
  `sessionAffinity: ClientIP`; with the NATS bridge stickiness is an efficiency
  choice, not a correctness one (§5).
- **Never deploy `--dev` artifacts.** A production build eliminates the debugbar
  and bakes `__IGNEX_PROD_BUILD` in at build time (§1).
- `reusePort` (§3) is worth enabling *inside* a pod only if you run several
  processes in one container; with `replicas` you already have process-level
  parallelism.

## 9. Backups & disaster recovery

What must survive a lost cluster, in priority order:

| State | Where it lives | Backup approach |
| --- | --- | --- |
| Application data | MongoDB | `mongodump`/operator backups + PITR (oplog) |
| Durable job queue | the `JobStore` backing store | back up with the datastore it uses; a lost queue replays as at-least-once, so idempotent handlers recover |
| Sessions / cache / rate limits | Redis | intentionally **not** backed up — treat as ephemeral and acceptable to lose |
| Secrets (`JWT_SECRET`, store credentials) | your secret manager | backed up out-of-band; rotating `JWT_SECRET` invalidates issued tokens |

Recovery drill — run it once *before* you need it:

```sh
# 1. Restore into a scratch database (never straight over production)
mongorestore --uri="$MONGO_URL" --archive=backup.archive \
  --nsFrom='app.*' --nsTo='app_restore.*'
# 2. Point a staging deployment at the restored data (env change only, no code)
# 3. Verify: readiness green, a read route returns real rows, a write route commits
```

- **RPO/RTO are deployment decisions, not framework defaults.** Choose the
  backup interval (RPO) and the acceptable restore time (RTO) explicitly, then
  rehearse the drill on the real platform.
- **Never store `.env` next to a data backup.** Secrets travel through the
  secret manager; a data-plane leak must not also hand over credentials.
- **Volume snapshots:** the only thing ignex writes to local disk in production
  is an opt-in file/SQLite durable job store. If you use it, that volume needs a
  snapshot too — or choose the Redis/Mongo store and let your datastore backup
  cover it.

## 10. Zero-downtime releases

The **ordering** matters more than the tooling:

1. **Schema first, expand-only.** Apply additive migrations
   (`ignex migrate up`) compatible with both the old and the new code: add
   columns/fields, never rename or drop in the same release.
2. **Roll the app.** `maxUnavailable: 0` plus the drain above. Workers
   (`ignex queue:work`) and the scheduler are separate Deployments and roll the
   same way — a job claimed by a dying worker is re-queued by lease expiry, so
   handlers must be idempotent (§4).
3. **Contract later.** Once the new code is fully rolled and the old code is
   gone, ship the destructive migration (drop/rename) in a follow-up release.

**Rollback is a redeploy of the previous image tag.** Because step 3 is deferred,
that older version still runs correctly against the new schema — which is exactly
what makes the rollback safe.

## 11. Reference: `ignex ops`

| Command | Emits |
| --- | --- |
| `ignex ops dockerfile` | Dockerfile + .dockerignore (multi-stage, standalone binary) |
| `ignex ops compose` | docker-compose.yml + .env.docker (MongoDB/Redis/NATS) |
| `ignex ops caddy` | Caddyfile (TLS, HTTP/2/3, `/health` probe) |
| `ignex ops ci` | CI workflow that builds + tests the container |

See also: [docs/sdk.md] (distributing the typed client), [docs/stability.md]
(risk register + gates), [docs/cookbook.md] (recipes), [docs/architecture.md]
(package layout + the AOT contract).
