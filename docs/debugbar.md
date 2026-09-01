# Debugbar — the developer dashboard

> A Laravel-debugbar-class observability layer, built into ignex, that turns
> "why is this endpoint slow?" and "what went wrong?" into one page. Active in
> **debug mode**, costs **one boolean check per request in production**, and
> ships its own knowledge-transfer docs so every developer — new or seasoned —
> understands how the app works without a hand-off document.

## UI tour

The dashboard is a dependency-free, tokenized dark UI (light theme via the
`◐` button or the `t` key, persisted in `localStorage`). It is designed for
long sessions: sticky table headers under the top bar, hover accents on rows,
tabular numerals in every metric, freshly-arrived traces flash once so the
live tail is visible without staring at timestamps, thin scrollbars,
`focus-visible` rings, and a `prefers-reduced-motion` guard:

- **Top bar** — service identity (`name@version · environment`), view tabs
  (Requests / Errors / Logs / History / Metrics / Diagnostics / System / State /
  Jobs / Routes / Events / Clients / AI / KT), a live-tail dot (amber when
  paused) and the theme toggle.
- **Status bar** — native-addon availability, the trace ring-buffer size, and
  the keyboard cheat-sheet.
- **Keyboard shortcuts** — `0`–`9` switch views, `/` focuses the search box,
  `r` refreshes the current view, `t` toggles the theme, `Esc` clears/blurs.
- **Requests** — stat cards (window count, errors, 4xx, 5xx, avg ms), a filter
  toolbar (search, method, status family — applied **server-side** via the
  `/api/requests` `q`/`method`/`status` params), and rows with color-coded
  method pills, status badges, inline duration bars and relative timestamps.
- **Request detail** — a summary strip (method pill, path, status, request id,
  ip, time, *copy curl*, *replay*) plus tabbed panels: **Overview** (stats,
  lifecycle stages, a time-breakdown panel, span tree), **Waterfall** (time
  breakdown, timeline ruler, color-coded bars, idle-gap segments, hover
  tooltips, expandable rows), **Queries**, **Headers** (redacted), **Body**
  (pretty JSON, copy), **Error** (stack, copy) and **Replay** (inline result).
- **Jobs** — status cards (queued/running/completed/failed) + recent-jobs table.
- **Events** — NATS event-queue tracking: stats (published/received/errors),
  a live payload table with subject filtering, and a publish composer for
  probe events.
- **Nova** — what fired in the app's nova FlatBuffer realtime transport
  (emits, publishes, client/remote/bridge inbound), newest first, with
  per-event counts and frame sizes. Wire it by passing the running nova
  handle to the debugbar:
  ```ts
  const nova = novaPlugin({ port: 3001 });
  export const plugins = [
    debugbar({ data: { nova: () => nova.server } }),
    nova,
  ];
  ```
- **Clients** — published SDK + FlatBuffers frontend clients with local
  versions and git tags (`sdk-v*`) — tagged ✓ vs local-only.
- **AI** — the compact `ai/summary` snapshot plus a copy-paste MCP config so
  an AI agent can connect and debug this app (see *AI debugging (MCP)* below).
- **Routes** — searchable inventory with method pills, source files and
  copy-path buttons.
- **System** — live gradient-filled charts for CPU / RSS / heap / event-loop
  delay with current/min/max labels, plus request totals and avg req/s.
- **KT** — a purpose-built onboarding surface rendered from the structured
  knowledge JSON: hero band with runtime chips, headline stat strip, the
  project map as a card grid (click any file to copy its path), the request
  flow as a stage pipeline, plugins/routes/database-activity/docs/SDK and
  environment sections. Falls back to server-rendered markdown for older
  payloads.

## What you get

| Feature | What it does |
| --- | --- |
| **Request waterfall** | Every request is traced end-to-end **automatically**: each lifecycle stage (request / handler / afterHandle / …) gets its own row, and every span your code records sits inside the handler at its true position. A time-breakdown panel (per-kind ms + %, idle/unaccounted gaps) makes the bottleneck visible at a glance, and rows unfold to show attrs, origin and errors. |
| **DB timing** | Queries recorded through `ctx.debug.query()` (or the free `debugQuery()`) get their own rows with millisecond timing, what was sent (params / full wire command) and what came back (result summary / reply preview), plus a per-request `db time` / `query count` headline. MongoDB: `instrumentMongoClient(client)` captures every driver round-trip at wire level. |
| **Errors + replay** | Every error (handler throw, hook failure, 5xx) is captured with its stack. Any stored request can be **replayed** with one click — re-issued through the live server, full routing and hooks — and the fresh result (status, duration, body) is shown inline. |
| **Logs** | Structured log capture: `ctx.debug.log(level, msg, attrs)` / the free `debugLog()` helper are correlated to the active request trace, and `console.*` calls are mirrored in (still printed). Level/text/time filters; click a row for the full record, or its *request ↗* link to jump to the request waterfall. |
| **History** | Everything (traces, spans, logs, samples) is persisted to a local SQLite db and survives restarts. Query the archive by time/text/method/status/errors/min-duration and reopen any past trace with its full span tree — post-mortems included. |
| **Metrics** | Per-route request/error counters and duration histograms with p50/p95/p99 estimates, system gauges and custom counters — plus a **Prometheus text endpoint** so Grafana boards scrape ignex directly, no agents. |
| **Diagnostics** | Leak detection with evidence: heap/RSS growth slopes (R²-gated), event-loop saturation, in-flight requests that never drain. One-click **run full GC** separates cache growth from a true leak. |
| **State** | A snapshot of application + process state: runtime facts, memory breakdown, environment-variable *names* (values never exposed), route/plugin inventory, feature flags. |
| **System profile** | CPU, RSS, heap and event-loop delay are sampled continuously and charted, alongside request totals (avg / p95 duration, error count, in-flight requests). |
| **Published SDK list** | The KT page lists the published SDK (name, version, location, files) generated by `ignex sdk`. |
| **KT — knowledge transfer** | A generated "how this app works" page for new developers: the **project map** ("where things live" — routes/models/middleware/hooks/views/config/lib/database probed on disk, with the route-file conventions), the repo's **documentation inventory** (every markdown doc with its title), the real route map (from the compiled `manifest.json` or the router) with per-route usage, registered plugins, lifecycle stages, the **DB activity actually observed** across retained requests (normalized statements + call counts + total time + the routes that ran them), span kinds, published SDK metadata, environment and runtime info. |
| **Function-call graph** | Each request detail shows the span tree (parent/child call graph) plus the waterfall, so you can see exactly what called what, when, and for how long. |

## Enabling

```ts
// src/app.config.ts
import { debugbar } from "@ignex/core";

export const plugins = [
  // ... your other plugins
  debugbar(),   // dashboard at /__debugbar
];
```

`debugbar()` is **on by default only in explicit debug mode**
(`NODE_ENV === "development"`, or `IGNEX_DEBUG=1`), and **off otherwise** —
including when `NODE_ENV` is unset (a staging box stays dark unless you opt
in). Where disabled, its only per-request cost is a single boolean check.

**New scaffolds ship it by default**: `ignex create` writes a baseline
`debugbar()` into every generated `src/app.config.ts` (alongside `session()`
and `openapi()`). Because the plugin self-disables outside debug mode and marks
itself dev-only, the compiled server drops it from the lifecycle at boot — a
default-mode `debugbar()` in your config costs nothing in production.

**Token auth never rides in API query strings.** With `token` set, endpoints
accept the `x-debugbar-token` header or the path-scoped HttpOnly
`__debugbar_token` cookie. Visiting `/__debugbar/?token=…` once performs the
handshake: the token is validated in constant time, an HttpOnly cookie is set
(scoped to the dashboard mount), and the request redirects to the token-less
path — so the token does not persist in per-request URLs, access logs, or
referrers.

The dashboard is served at `http://localhost:<port>/__debugbar/` (the bare
mount redirects there). When the debugbar is active, its URL is **logged to
the console at boot**:

```
[ignex] debugbar: https://localhost:3000/__debugbar/ — waterfall + replay, logs, metrics (Prometheus), leak diagnostics, SQLite history, NATS events, KT docs (debug mode)
```

If the actual serving URL differs from the boot hint (custom hostname,
`port: 0`, `https: false`), the exact URL is logged again on the first traced
request.

The example app opts in via its own `DEBUG` flag
(`DEBUG=true` in the shell or `packages/app/.env`) for dev runs:

```sh
DEBUG=true bun run dev     # example app → open /__debugbar
```

> **In production** (`NODE_ENV=production`) the plugin cannot boot unless you
> explicitly set `IGNEX_DEBUG=1` in the process — an explicit
> `enabled: true` in config is overridden there (a one-time warning explains
> it). This keeps a stray `DEBUG=true` env file from shipping a dev toolbar
> into production. Outside production, `enabled: true` forces it on (e.g. a
> staging box behind a VPN); `enabled: false` forces it off anywhere.

## Production impact: zero

The debugbar is a **development tool** — a production build must not pay for
it, and doesn't. Three layers guarantee that:

1. **Build-time elimination.** When the compiler builds a production artifact
   (`ignex build` by default — see below, `--compile`, the explicit
   `production` option, or `NODE_ENV=production` at build time, without
   `IGNEX_DEBUG=1`), it proves every reachable `debugbar()` in your
   `plugins` array — default mode, `enabled: true`, or any runtime
   expression — can never legitimately boot, and **eliminates it from the
   per-request lifecycle**: routes keep constant-response hoisting,
   usage-specialized contexts and sync fast paths exactly as if the plugin
   were never there. An explicit `debugbar({ enabled: false })` is eliminated
   in any build. The only way to keep the toolbar inside a production-built
   artifact is `IGNEX_DEBUG=1` at build time — an explicit opt-in that also
   flips the build back to dev-shaped instrumentation.

   > **`ignex build` defaults to a production shape** (since it emits the
   > deploy artifact): the toolbar, observatory stack and per-request tracing
   > instrumentation are treeshaken out even when the build shell has no
   > `NODE_ENV` set, and the artifact bakes its production shape
   > (`__IGNEX_PROD_BUILD`) so launching it bare cannot re-enable dev tooling.
   > Pass `--dev` for a dev-shaped artifact (e.g. to attach the debugbar to a
   > staging build), or set `IGNEX_DEBUG=1` at build time to keep the toolbar
   > inside an otherwise production-shaped build. In config-driven builds
   > (`builder.ts`, CI scripts) the same knob is the compiler's
   > `production: true` option.
2. **Runtime self-elimination.** Even when a dev-built artifact is later run
   with `NODE_ENV=production`, a disabled `debugbar()` marks itself
   `__ignexDevOnly` and the compiled server filters it out of the lifecycle at
   boot — zero per-request hook costs in production. And the runtime guard
   means an `enabled: true` instance cannot switch itself on in a prod
   process without `IGNEX_DEBUG=1`.
3. **Zero-cost context.** `ctx.debug` is a prototype getter returning a shared
   no-op — production contexts carry **no extra field**; the plugin only
   swaps in a per-request API (via `Object.defineProperty`) while actively
   tracing in debug mode.
4. **Cache-safe elimination.** The build cache fingerprint includes
   `NODE_ENV` / `IGNEX_DEBUG` and the explicit `production` option (the
   elimination inputs), so a production build can never poison the dev cache
   with eliminated routes — and vice versa. A dev build after a prod build
   still ships the full-context pipeline for a kept `debugbar()`.

Verify it yourself: build with `NODE_ENV=production`, boot, and `GET
/__debugbar/` returns 404 with normal routes unaffected.

> To run the dashboard against a production-built artifact (e.g. a staging
> box), set `IGNEX_DEBUG=1` — at build time it keeps the toolbar in the
> artifact (and the full-context pipeline for that build), and at runtime it
> lets the plugin boot inside a prod process. Prefer gating it out of the
> plugin list entirely in production configs.

## Options

```ts
debugbar({
  path: "/__debugbar",        // mount path
  maxTraces: 500,             // in-memory ring buffer size
  captureBody: false,         // capture request bodies (needed to replay POSTs)
  systemSampleMs: 1000,       // CPU/memory sampling interval (0 = off)
  token: "secret",            // require x-debugbar-token header / __debugbar_token cookie
  serviceName: "my-api",      // shown in the dashboard + KT page
  version: "1.4.2",
  manifestPaths: ["dist/manifest.json"],   // AOT route map for the KT page
  sdkPaths: ["dist/sdk/package.json"],     // published-SDK metadata probes
  docsPaths: ["docs", "."],                // KT documentation inventory scan roots
  projectRoot: ".",                        // where the KT project map + docs scan probe
  clientPaths: ["dist/sdk/flatbuffers"],   // frontend-client probes (Clients panel)
  // NATS event tracking (Events panel). URL defaults to $NATS_URL.
  nats: {
    url: "nats://localhost:4222", // nats:// or tls:// host[:port]
    subjects: ["events.>"],       // subscribe for inbound tracking
    maxEvents: 500,               // ring buffer of tracked events
    connect: true,                // dial at startup (failures are recorded, never thrown)
  },
  plugins: ["myPlugin"],      // extra plugin inventory for the KT page
  dispatch: (req) => app.handler(req),     // explicit replay dispatcher
  // Structured log capture (Logs panel). console mirroring is on by default;
  // disable it or resize the in-memory ring here.
  logs: { console: true, maxRecords: 2000 },
  // SQLite persistence (History panel). ON by default in debug mode at
  // <cwd>/.ignex/observatory.db — batched WAL writes + retention pruning.
  persist: {
    path: ".ignex/observatory.db",
    flushIntervalMs: 1000,
    maxAgeSec: 7 * 24 * 3600,   // retention window
    maxRows: 100_000,           // hard per-table cap
  },
  // Nova (FlatBuffer realtime transport) probe — what fired, for the Nova
  // panel + the MCP `debug-nova-events` tool + the AI summary's nova block.
  data: { nova: () => nova.server },
})
```

The NATS integration is **zero-dependency**: a minimal core-protocol client
(INFO/CONNECT/PING/PONG/PUB/SUB/MSG) over Bun's TCP sockets — no npm package
needed, JetStream-free by design. Publishing from your own code works through
the same tracker so the Events panel sees it:

```ts
import { NatsEventTracker } from "@ignex/core";
const tracker = new NatsEventTracker(); // reads $NATS_URL
tracker.start();
tracker.publish("orders.created", { orderId: "o-1" }); // recorded in the Events panel
```

## Tracing from your code

`ctx.debug` is always present — it is a shared **no-op** unless the plugin
replaced it for the current request — so handlers can call it unconditionally
and pay nothing in production:

```ts
export default get(async (ctx) => {
  // Time a database query (kind: "db") — headline metric in the dashboard.
  const user = await ctx.debug.query(
    "SELECT * FROM users WHERE id = ?",
    [ctx.params.id],
    () => db.query("SELECT * FROM users WHERE id = ?", [ctx.params.id]),
  );

  // Time any async work.
  await ctx.debug.span("enrich: fetch profile", "http", async () => {
    return fetch("https://profile.internal/users/" + user.id);
  });

  // Record a cache operation with a known duration.
  ctx.debug.cache(true, "user:" + user.id, 0.4);

  // Record an error against this request (surfaces in the Errors view).
  ctx.debug.error(err);

  return ctx.json({ user });
});
```

### Free helpers (`@ignex/core/debug`)

Code that has no `ctx` (DB drivers, SDKs, utilities called from anywhere in
the request's async chain) can use the ALS-propagated free functions — they
attach to the currently-executing request automatically:

```ts
import { debugQuery, debugSpan } from "@ignex/core/debug";

export async function findUser(id: string) {
  return debugQuery("SELECT * FROM users WHERE id = ?", [id], () => runSql(...));
}
```

`debugSpan(name, kind, fn)`, `debugQuery(sql, params, fn)`, `debugCache(...)`,
`debugEvent(name, attrs)`, `debugError(err)` — all no-ops when no request
trace is active (background jobs, production, plugin absent).

### Span kinds and the waterfall

| Kind | Color | Typical use |
| --- | --- | --- |
| `lifecycle` | cyan | framework stages (request / handler / response) |
| `db` | blue | queries, transactions |
| `cache` | green | cache get/set/invalidate |
| `http` | purple | outbound fetches |
| `render` | amber | templates, file serving |
| `auth` | pink | JWT / sessions / guards |
| `custom` | grey | anything else |
| `error` | red | failed spans |

## How the waterfall works

The plugin traces the request **automatically** — no instrumentation needed in
your handlers to see the shape of a request:

- Every lifecycle stage becomes a row: `request` (the onRequest hooks),
  `beforeHandle`, **`handler`** (the big one), `afterHandle`, `mapResponse`,
  `afterResponse` and `trace` — each with its own bar and exact duration.
- Every span your code records (`ctx.debug.*` / the free helpers) sits inside
  the handler row at its true position, so a slow query, cache miss or
  outbound HTTP call is visible immediately.
- **Where the time went** — both the Overview and Waterfall tabs show a
  time-breakdown panel: a stacked bar + per-kind rows (db, cache, http,
  render, auth, lifecycle, custom) with milliseconds and % of the total.
- **Idle gaps** — time between spans that no row accounts for (event-loop
  waits, untraced I/O) is drawn as thin hatched segments, so "what is this
  request waiting on?" has an answer.
- Rows are **expandable**: click any bar to unfold its details (span kind,
  start/duration, attrs like the query text or target URL, origin stack
  frame, error). Bars are sized relative to the total request duration;
  hovering shows the exact start/duration; failed spans are marked ✕ and
  open spans (request cut short) are flagged ⏳.

## Errors and replay

- The **Errors** tab lists every request that carried an error (thrown
  handler, failed hook, validation failure, 5xx).
- The request detail shows the error message + top stack frames and the
  response that was produced.
- **↻ Replay request** re-issues the exact stored request (method, path,
  headers, body when captured) through the live server — native route table,
  hooks, plugins all run — and shows the fresh status, duration and body.
  Replayed requests appear in the list as new traces so you can diff runs.

> Replay of requests with a body requires `captureBody: true`. Sensitive
> headers (authorization, cookie, api keys) are stored for replay fidelity but
> **redacted** in the dashboard API.

## Source positions (sourcemaps)

Stack frames captured by the tracer (`errorStack`, span `origin`) are
remapped to your TypeScript sources:

- The compiler emits a source map next to the server bundle by default
  (`sourceMap: true` → `<out>.js.map`). Bun does **not** apply source maps
  to runtime stack traces itself, so `@ignex/core`'s debug layer ships its
  own remapper: frames whose file has an adjacent `.map` are translated
  back through the v3 VLQ mappings (negative-cached — files without maps
  pass through untouched).
- Independent of sourcemaps, `GET /api/requests/:id` resolves the matched
  route's repo-relative **source file** from the AOT manifest and returns
  it as `sourceFile` (e.g. `src/routes/users/[id].get.ts`); the request
  detail's meta panel shows it as the `source` row.

## System profile

CPU, RSS, heap and event-loop delay are sampled every `systemSampleMs` (the
interval is unref'd — it never keeps the process alive) and charted as
sparklines, alongside request totals: traced count, error count, avg and p95
duration.

## Logging (Logs panel)

Three ways in, one store:

```ts
// inside a request — correlated to the current trace automatically
ctx.debug.log("warn", "payment retry", { attempt: 2 });

// anywhere else (jobs, libs) via the ALS-propagated helper
import { debugLog } from "@ignex/core/debug";
debugLog("error", "cache backend down", { backend: "redis" });
```

- **Console mirroring** — `console.debug/log/info/warn/error` are mirrored
  into the Logs panel (source `"console"`) while still printing normally.
  Disable with `debugbar({ logs: { console: false } })`.
- **Filters** — `GET /api/logs` accepts `level` (minimum), `q` (substring),
  `traceId`, `since`/`until` and `limit`; the dashboard toolbar exposes all of
  them plus a SQLite toggle for the persisted archive.
- **Log detail** — click a row to open the full record: message, structured
  fields, level/source/time and its request correlation. The *request ↗*
  button (and the row's trace link) jumps to the owning request's waterfall.

## Database capture (Queries tab + wire monitor)

Every query recorded through `ctx.debug.query()` / the free `debugQuery()`
gets a timed `db` span — and `params` accepts any JSON-safe payload
(positional SQL binds as an array, a Mongo filter/options document as an
object), stored verbatim as WHAT WAS SENT. The Queries tab shows each
query's duration, sent payload (expandable) and result summary / reply
preview; a `↳` marks wire-level round-trips nested under an ORM operation.
Nested `db` spans are excluded from the per-request db-count/db-time
aggregates, so totals stay truthful even when both layers record.

Two ways to capture MongoDB traffic:

**ORM boundary wrapping** (what the reference app does): if all your DB calls
funnel through one accessor/proxy, wrap it with `debugQuery()` — the call
args become the sent payload and the result summary is captured
automatically. See `packages/app/src/db.ts`, gated by `env.DEBUG`.

**Driver command monitor**: `instrumentMongoClient(client)` hooks the
`mongodb` driver's APM events so every actual wire round-trip inside a
traced request is recorded with the full command (`find app.gigs`), the
reply preview and the driver-reported duration:

```ts
import { instrumentMongoClient } from "@ignex/core/debug";

// BEFORE opening connections — pooled connections snapshot the flag at
// construction, so an already-warm pool stays silent.
instrumentMongoClient(mongoClient);
await mongoClient.connect();
```

## Metrics + Grafana (Metrics panel)

Every finalized request feeds per-route aggregates keyed by method + route
pattern (`GET /users/:id`) — request/error counters, status families and a
duration histogram with p50/p95/p99 estimates — while system gauges update on
each profiler sample. App code can add counter series through
`MetricsRegistry.incCounter()` (exported from `@ignex/core/debug`).

Two read shapes:

| Endpoint | Shape |
| --- | --- |
| `GET /api/metrics` | JSON snapshot (totals, gauges, counters, per-route rows) |
| `GET /api/metrics/prometheus` | Prometheus text exposition (`text/plain; version=0.0.4`) |

Point a Prometheus scraper at the exposition endpoint and Grafana just works:

```yaml
scrape_configs:
  - job_name: ignex-dev
    scrape_interval: 5s
    metrics_path: /__debugbar/api/metrics/prometheus
    static_configs:
      - targets: ["localhost:3000"]
```

Metric families: `ignex_http_requests_total{route}`,
`ignex_http_requests_errors_total{route}`,
`ignex_http_request_duration_ms_bucket/_sum/_count{route}`,
`ignex_db_queries_total{route}`, `ignex_process_rss_mib`,
`ignex_process_heap_used_mib`, `ignex_event_loop_delay_ms`,
`ignex_active_requests` and app counters as `ignex_counter{name,…}`.

## Leak diagnostics (Diagnostics panel)

The analyzer fits least-squares trends over the trailing sample window
(default 10 min) and gates them by R², so noise never becomes a false alarm:

| Rule id | Detects | Severity ladder |
| --- | --- | --- |
| `heap-growth` | Sustained heap climb (MiB/min + fit quality) | warning ≥0.5 MiB/min → critical ≥4 |
| `rss-growth` | Native/buffer growth outside the JS heap | same thresholds |
| `event-loop-saturation` | p95 loop delay across the window | warning ≥50 ms → critical ≥200 ms |
| `active-requests-growth` | In-flight requests that never drain (hanging awaits) | warning |

Each finding ships measured evidence (slope, R², min/now/peak, window) and a
concrete recommendation — both in the dashboard and over MCP. The **run full
GC** action (`POST /api/diagnostics/gc`) forces a collection and reports freed
MiB: after GC, healthy memory falls back toward its floor and stays there; a
leak resumes climbing from the floor.

## Persistence + history (History panel)

Debug mode persists everything — finalized traces with spans, structured
logs, system samples — to a WAL-mode SQLite db (`bun:sqlite`, zero new
dependencies). Writes are batched (1 s flush timer) so the request hot path
only queues; retention pruning keeps the file bounded.

```ts
debugbar({
  persist: {
    path: ".ignex/observatory.db",
    maxAgeSec: 7 * 24 * 3600, // default retention
    maxRows: 100_000,
  },
  // persist: false → disable entirely
});
```

Because the archive is local and durable, the History panel answers "what
happened before I opened this?" and survives restarts:

- `GET /api/history?since=&until=&q=&method=&status=&error=1&minMs=&limit=` —
  persisted summaries, newest first;
- `GET /api/history/:id` — one fully reconstructed trace (span tree included);
- `{path}/api/meta` → `features.history` reports whether persistence is live.

## Application state (State panel)

`GET /api/state` snapshots what the process actually looks like right now:
runtime facts (Bun/platform/pid/uptime), memory breakdown, environment
variable **names** (values are never exposed), route/plugin inventory, store
sizes and feature flags.

## NATS event tracking (Events panel)

With `nats` configured (or `$NATS_URL` set), the debugbar tracks your
event-queue traffic:

- **Events** view — stat cards (window total, published vs received, errors,
  bytes), a live table (time, direction, subject, size, truncated payload),
  per-subject filtering, and a **publish composer** to send probe events
  (`orders.created` + JSON payload → `POST /api/events/publish`) so you can
  test consumers without leaving the dashboard.
- **Inbound tracking** — the tracker subscribes to `subjects` (default
  `events.>`) and records every matching message with its payload.
- **Outbound tracking** — publishes made through the tracker (dashboard
  composer, `NatsEventTracker` in your app) are recorded, including failures
  (server down, not connected) so the panel always shows *what happened*.
- **Resilient** — a missing/broken NATS server never crashes the app: boot
  logs the connection status, failures become error events, and the tracker
  reconnects with backoff.

## Published clients (Clients panel)

The **Clients** view answers "what did we ship to frontend teams, and where?"
It probes the SDK packages and frontend clients (`sdkPaths` + `clientPaths` —
directories with `package.json`, the `package.json` itself, or `sdk.json`) and
combines them with git state:

- **Local** — package name, version, location and shipped files, read straight
  off disk.
- **Git tags** — `git for-each-ref` (cached 30s, refreshed by
  `GET /api/clients?refresh=1`) lists the `sdk-v*` tags — the release signal
  `ignex sdk --push` creates — so a package shows **tagged ✓** when its tag
  exists, **local only** otherwise.
- **SDK vs client** — `kind: "sdk"` packages (typescript/openapi SDKs) and
  `kind: "client"` packages (the FlatBuffers frontend client — see below) are
  shown with distinct badges and their platforms.

## AI debugging (MCP)

An AI agent can connect to a **running** app's debugbar over MCP and debug
issues directly — no context dump, no full logs. Point any MCP client at the
`@ignex/mcp` server with two env vars:

```jsonc
{
  "mcpServers": {
    "ignex-debug": {
      "command": "bunx",
      "args": ["@ignex/mcp"],
      "env": {
        "IGNEX_DEBUGBAR_URL": "http://localhost:3000/__debugbar",
        "IGNEX_DEBUGBAR_TOKEN": ""   // only if debugbar({ token }) is set
      }
    }
  }
}
```

Tools (the dashboard's **AI** view shows this config + the tool list):

| Tool | What the agent gets |
| --- | --- |
| `debug-summary` | **one compact JSON** — errors, slow traces, event stats, clients **plus the observatory block** (leak verdict, recent warnings, persistence state). The token-efficient entry point. |
| `debug-requests` | recent traces, server-side filtered (`error`, `q`, `method`, `status`, `limit`) |
| `debug-request` | full trace: span tree, waterfall timings, queries, redacted headers, stack |
| `debug-replay` | re-issue a stored request through the live server |
| `debug-logs` | structured logs filtered by level/text/trace; `persisted: true` reads the SQLite archive |
| `debug-metrics` | per-route aggregates + gauges; `format: "prometheus"` returns the raw exposition |
| `debug-diagnostics` | leak findings with evidence + recommendations; `gc: true` forces a collection first |
| `debug-state` | application/process snapshot (memory, env names, features) |
| `debug-history` | SQLite-persisted traces across restarts (filters + single-trace reconstruction) |
| `debug-events` / `debug-event-publish` | inspect the NATS queue, publish probe events |
| `debug-system` | CPU/RSS/heap/event-loop profile |
| `debug-clients` | published SDK + client state (local version, git tags) |
| `debug-kt` | the "how this app works" markdown — instant onboarding |

Flow: `debug-summary` → spot an error or a leak verdict → `debug-request`
for the spans → `debug-replay` to reproduce → `debug-logs` /
`debug-diagnostics` for correlated evidence → `debug-event-publish` to test
the event flow.

## KT — knowledge transfer

The **KT · How it works** page is generated from real artifacts, never prose —
it answers the questions a new developer asks on day one:

- **Where things live** — the conventional app directories (`src/routes`,
  `src/models`, `src/middleware`, `src/hooks`, `src/views`, `src/config`,
  `src/lib`, `db`) are probed on disk and listed with what they contain and
  what they're for, plus the route-file conventions (the filename IS the
  URL: `users/[id].get.ts` → `GET /users/:id`).
- **Documentation** — every markdown doc in the repo (scanned in `docs/` and
  the project root by default; tune with `debugbar({ docsPaths })`) listed
  path → title, extracted from each file's first heading. README first.
- **Database activity** — every `db` span across the retained request traces
  aggregated into normalized statement patterns: action verb, table, call
  count, total time, and which routes performed it. This is what the app
  *actually does* to the database, not what a schema diagram claims. Empty?
  The page explains how to record queries (`ctx.debug.query()` /
  `debugQuery()`).
- The route map — from the AOT `manifest.json` artifact (per-route usage,
  hooks, response type) or the interpreted router's registrations,
- the registered plugin inventory with descriptions,
- the lifecycle stage inventory,
- the span kinds your app can emit,
- the published SDK metadata (from `ignex sdk` artifacts),
- the environment + runtime (Bun version, platform, pid, NODE_ENV, PORT…).

Hand a new developer the URL instead of an onboarding doc: they can see where
everything lives, which docs exist, what the deployment does, which routes
touch what, and how requests flow.

KT options: `docsPaths` (documentation scan roots, default `["docs", "."]`)
and `projectRoot` (where the project map + docs scan probe, default
`process.cwd()`).

## How it's wired

The plugin is a thin composition root; everything else lives in focused
modules under `packages/core/src/`:

- `plugins/debugbar.ts` — options parsing, the production lock, lifecycle
  hooks (`onRequest` starts a trace + seeds the ALS; `onResponse`/`onError`
  finalize and store), and revision-counter wiring for live updates.
- `debug/server/auth.ts` — the token gate: header/cookie auth with a
  constant-time compare plus the one-time `?token=` → HttpOnly-cookie page
  handshake.
- `debug/server/assets.ts` — precomputed HTML shell (strict CSP:
  `default-src 'none'`, same-origin script/style/connect only) and the bundled
  SPA with content-hash ETags (304 revalidation instead of re-sending ~95 KiB).
- `debug/server/endpoints.ts` — ONE declarative endpoint table that drives
  both serving modes: O(segments) matching for AOT interception and automatic
  router registration for interpreted apps (no hand-maintained duplicate).
- `debug/server/handlers/data-panels.ts` — requests/history/logs/metrics/
  system/diagnostics handlers (limit clamping, method guards).
- `debug/server/handlers/app-panels.ts` — KT/SDKs/clients/jobs/routes/events/
  nova/AI-summary handlers.
- `debug/server/revisions.ts` + `stream.ts` — mutation counters per data domain
  and the SSE hub that pushes them (single-use short-TTL tickets authenticate
  EventSource without ever putting tokens in query strings at rest).
- `debug/ui/` — the SPA source (SolidJS + Tailwind, compiled ahead of time):
  - `ui/views/*` — one small component per panel (requests, detail, logs,
    history, metrics, diagnostics, system, state, jobs, routes, events,
    clients, AI, KT) behind a hash router (#/requests/:id/:tab — deep links
    survive refresh, the back button works). Solid's fine-grained reactivity
    means a new trace row appears by inserting one `<tr>`, not re-rendering
    the table's innerHTML; keyed lists preserve row DOM across stream bumps.
  - `ui/components/*` — shared widgets (panels, stat cards, pills, bars,
    waterfall/breakdown/query sub-renderers) plus the keyed-identity merge
    that keeps `<For>` rows stable across refetches.
  - `ui/styles.css` — the Tailwind input: token palette (CSS variables
    switched by `data-theme`), `@theme` mappings that turn those tokens into
    utilities (`bg-panel`, `text-muted`, …) and the few custom component
    styles (pills, waterfall, KT hero, animations).
  - `ui/{router,live,theme,api,format}.ts` — hash router, the revision-pulse
    bus, theme persistence, the typed API client and pure formatting helpers.
- `scripts/gen-debug-ui.ts` — compiles `ui/` ahead of time into the committed
  `debug/dashboard-client.gen.ts` (content-hashed): babel-preset-solid +
  @babel/preset-typescript for the JSX, `@tailwindcss/cli` for the stylesheet,
  then `Bun.build` for the IIFE. No runtime build step, packages stay
  source-only; CI verifies freshness via `bun run check:debug-ui`. Edit `ui/`,
  then run `bun run gen:debug-ui`.
- `debug/tracer.ts` / `store.ts` / `system.ts` / `logs.ts` / `metrics.ts` /
  `persist.ts` / `leaks.ts` / `state.ts` / `kt.ts` — unchanged runtime core;
  the store/log/NATS classes now accept an optional `onNotify` hook that feeds
  the revision counters.

## API endpoints

All under `{path}` (default `/__debugbar`):

| Endpoint | Purpose |
| --- | --- |
| `GET /` | dashboard shell (redirects from the bare mount) |
| `GET /app.js` | dashboard app (static asset, no token required) |
| `GET /api/meta` | service name/version/env/debug mode |
| `GET /api/requests?limit=&error=&q=&method=&status=` | trace summaries (newest first, server-side filters) |
| `GET /api/requests/:id` | full trace (waterfall data, headers redacted) |
| `POST /api/requests/:id/replay` | replay the request, return the fresh result |
| `GET /api/requests/clear` | clear the store |
| `GET /api/system` | system samples + request totals |
| `GET /api/logs?level=&q=&traceId=&since=&until=&limit=&persisted=` | structured log records + per-level stats |
| `GET /api/logs/:id` | one full log record (message, attrs, request correlation) |
| `POST /api/logs/clear` | clear the live log ring |
| `GET /api/metrics` | JSON metrics snapshot (routes, gauges, counters) |
| `GET /api/metrics/prometheus` | Prometheus text exposition (for Grafana scrapes) |
| `GET /api/diagnostics` | leak/trend report + persistence status |
| `POST /api/diagnostics/gc` | force full GC, report freed memory |
| `GET /api/state` | application/process state snapshot |
| `GET /api/history?since=&until=&q=&method=&status=&error=&minMs=&limit=` | persisted trace summaries (cross-restart) |
| `GET /api/history/:id` | one reconstructed persisted trace (with spans) |
| `GET /api/kt` | knowledge markdown + structured knowledge |
| `GET /api/sdks` | published-SDK metadata (enriched with git tags) |
| `GET /api/clients?refresh=` | published SDK + frontend clients (local + git tags) |
| `GET /api/events?limit=&subject=` | NATS event stats + recent events |
| `POST /api/events/publish` | publish a probe event `{ subject, payload }` |
| `POST /api/events/clear` | clear the event buffer |
| `GET /api/ai/summary` | compact AI-facing snapshot (errors, slow traces, events, clients, observatory verdict) |
| `POST /api/stream/ticket` | mint a single-use, short-TTL ticket authorizing one stream connection |
| `GET /api/stream?ticket=` | Server-Sent-Events revision stream (per-domain mutation counters; falls back to polling when unavailable) |

### Live updates

Dashboards subscribe to `/api/stream`: every request completion, log line,
metric update or system sample bumps a counter, and connected dashboards
receive one tiny JSON frame they use to refetch ONLY the endpoints whose
domain moved. This replaces blind polling — a quiet server costs nothing but
a heartbeat comment every 15 s. When EventSource is unavailable (or the
stream drops repeatedly), the client degrades automatically to 5-second
polling. Pause (⏸ / click the live dot) freezes refetching without tearing
down the connection.

### Deep links

Every panel has a URL: `#/requests`, `#/errors`, `#/requests/<id>/<tab>`
(waterfall/queries/headers/body/error/replay), `#/logs/<id>`, `#/history`,
`#/metrics`, `#/diagnostics`, `#/system`, `#/state`, `#/jobs`, `#/routes`,
`#/events`, `#/clients`, `#/ai`, `#/kt`. Detail links resolve live-ring traces
first and persisted history second, so bookmarks keep working after restarts.

The dashboard's own requests are excluded from tracing, and the endpoints are
kept out of the OpenAPI document.
