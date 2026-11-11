# Debugbar

A Laravel-debugbar-class observability dashboard, built into ignex, that
turns "why is this endpoint slow?" and "what went wrong?" into one page.
Active in **debug mode**, costs **one boolean check per request in
production**, and ships its own knowledge-transfer surface so every
developer — new or seasoned — understands how the app works without a
hand-off document.

```ts
// src/app.config.ts — scaffolds ship this by default
import { debugbar } from "@ignex/core";

export const plugins = [
  // ...
  debugbar(), // dashboard at /__debugbar
];
```

Open **`http://localhost:3000/__debugbar/`** — the URL is logged at boot. Where it fits in the daily flow: the [tour](./tour).

## Views

The dashboard is a dependency-free, tokenized UI (light/dark theme via the
`t` key, persisted), with a collapsible sidebar, a command palette
(`⌘K`/`Ctrl-K`), keyboard shortcuts (`0`–`9` switch views, `/` search, `r`
refresh) and a live tail that pauses when you scroll. The view groups:

| Group | Views |
| --- | --- |
| **Application** | Overview — retained-window health, active requests, p95 latency, and **prioritized findings**: each carries measured evidence, a concrete recommendation, and a direct link to the failing request, query list, logs, metrics or runtime controls |
| **Observe** | Requests (stat cards + server-side filters), request detail, Errors (fault-code badge + filter), Logs, History (SQLite archive), Routes (searchable inventory) |
| **Runtime** | Metrics (+ Prometheus exposition), System (CPU/RSS/heap/event-loop charts), Diagnostics (leak detection), State (env names, routes, flags — **values never exposed**), Jobs |
| **Integrations** | Events (NATS + nova realtime traffic, see below), Clients (published SDK packages), AI (agent config + tool list) |
| **Reference** | KT (knowledge transfer), Docs (your repo's markdown, rendered in the dashboard) |

## Request waterfall

Every request is traced **automatically** — no instrumentation needed to see
its shape:

- Each lifecycle stage gets a row (`request`, `beforeHandle`, **`handler`**,
  `afterHandle`, `mapResponse`, `afterResponse`) with exact durations, and
  every span your code records sits inside the handler at its true position.
- A **time-breakdown panel** (per-kind ms + %: db, cache, http, render,
  auth, custom) makes the bottleneck visible at a glance; rows unfold to
  attrs, origin stack frame and errors.
- **Idle gaps** — time no row accounts for — are drawn as hatched segments,
  so "what is this request waiting on?" has an answer.
- `copy curl` and **replay** buttons live on the request detail; the
  matched route's source file (`src/routes/...`) is shown in the meta panel.

Record spans from your own code — `ctx.debug` is a shared **no-op** in
production, so calls are unconditional and free when the bar is off:

```ts
export default get(async (ctx) => {
  const user = await ctx.debug.query(
    "SELECT * FROM users WHERE id = ?",
    [ctx.params.id],
    () => db.query("SELECT * FROM users WHERE id = ?", [ctx.params.id]),
  );

  await ctx.debug.span("enrich: fetch profile", "http", async () =>
    fetch("https://profile.internal/users/" + user.id),
  );

  ctx.debug.error(err); // surfaces in the Errors view, classified
  return ctx.json({ user });
});
```

Code without a `ctx` (drivers, SDKs) uses the ALS-propagated free helpers —
they attach to the executing request automatically and no-op elsewhere:

```ts
import { debugQuery, debugSpan, debugLog } from "@ignex/core/debug";

export async function findUser(id: string) {
  return debugQuery("SELECT * FROM users WHERE id = ?", [id], () => runSql(id));
}
```

## Errors: the fault, not a paraphrase

The debugger carries the **same fault the terminal report prints** (the
[Errors](./errors) taxonomy): `toFault` runs once, and the classification
rides the trace — dashboard, history archive, AI summary and MCP tools all
show the identical object.

- The **Errors** view badges every row with its fault code
  (`IGN_DB_CREDENTIALS`, `VALIDATION_ERROR`, …) and offers a filter built
  from the codes actually present.
- The request detail's **Error** tab leads with the classification (origin ·
  service, kind, code, status, `what`, the driver's message), then **What to
  fix** (the operator hints), the **cause chain** — and the stack comes
  *last*: a stack answers "where", the fault answers "why".
- Failed spans are marked in the waterfall; a caught span failure is
  classified too (the response stays a 200 while the row says *why*).
- **Replay** re-issues the exact stored request through the live server —
  routing, hooks, plugins — and shows the fresh status, duration, body.
  Replays appear as new traces so runs can be diffed.
- **Sourcemaps included**: compiled artifacts report bundle coordinates, so
  the debug layer remaps fault frames back to your `.ts` — the Error tab
  splits **Your code** from **Framework & dependencies**, and even a
  dependency raising across an `await` (stack truncated) still names your
  caller (`in your code` above `raised in`).

## Logs, queries, metrics

- **Logs** — `ctx.debug.log(level, msg, attrs)` correlates to the active
  trace; `console.*` calls are mirrored (still printed). Level/text/time
  filters; each row links to its request waterfall.
- **Queries** — every `ctx.debug.query()` gets a timed `db` span with what
  was sent (params/commands) and what came back. `instrumentMongoClient(client)`
  captures **every** Mongo wire round-trip at driver level (call it before
  `connect()`).
- **Metrics + Grafana** — per-route request/error counters and duration
  histograms (p50/p95/p99), exposed as a **Prometheus text endpoint**:

  ```yaml
  scrape_configs:
    - job_name: ignex-dev
      metrics_path: /__debugbar/api/metrics/prometheus
      static_configs:
        - targets: ["localhost:3000"]
  ```

- **Diagnostics** — leak detection with evidence: heap/RSS growth slopes
  (R²-gated, so noise never alarms), event-loop saturation, requests that
  never drain. One-click **run full GC** separates cache growth from a real
  leak.
- **History** — traces, logs and samples persist to a local WAL-mode SQLite
  db (batched writes, retention pruning) and **survive restarts**: query by
  time/text/method/status/errors/duration and reopen any past trace.

## Events: NATS + nova realtime in one buffer

The **Events** view interleaves both transports so you can see, side by
side, what the app sent and received over the wire:

- **NATS bus** — a zero-dependency client (no npm package) tracks publishes
  and subscriptions, including failures; a composer lets you fire probe
  events without leaving the dashboard.
- **nova realtime (FlatBuffer wire)** — wire `data: { nova: () => nova.server }`
  and every `out.emit` (server → client) and `in.client` / `in.remote` /
  `in.bridge` (client / peer / NATS bridge → server) row appears with
  direction pills, event names, targets, byte sizes and payload previews
  (`novaPlugin({ trace: { capturePayloadChars: 400 } })`). An **emit
  composer** fires real wire events — broadcast or targeted
  (`user:u-42`, `group:premium`, `topic:room`) — so consumers can be
  exercised end to end.

```ts
export const plugins = [
  debugbar({ data: { nova: () => nova.server } }),
  nova,
];
```

The wire format itself is **FlatBuffers**: nova events decode with pure JS
(no FFI on the client), and the typed bindings are generated — the full
flow is in [Realtime](./realtime).

## KT: "how this app works" for new developers

The **KT** page is generated from real artifacts, never prose — the project
map (routes/models/middleware/hooks/views/config/lib probed on disk), the
documentation inventory, the real route map with per-route usage, the
database activity **actually observed** across retained requests (normalized
statements + call counts + the routes that ran them), plugins, lifecycle
stages, span kinds, published SDK metadata, and the environment. Hand a new
developer the URL instead of an onboarding doc — and the **Docs** panel
renders your repo's markdown in place, cross-linked from KT.

## AI debugging (MCP)

An AI agent connects to a **running** app's debugbar over MCP and debugs
issues directly. The dashboard's **AI** view shows a copy-paste config:

```jsonc
{
  "mcpServers": {
    "ignex-debug": {
      "command": "bunx",
      "args": ["@ignex/mcp"],
      "env": {
        "IGNEX_DEBUGBAR_URL": "http://localhost:3000/__debugbar",
        "IGNEX_DEBUGBAR_TOKEN": "" // only if debugbar({ token }) is set
      }
    }
  }
}
```

| Tool | What the agent gets |
| --- | --- |
| `debug-summary` | **One compact JSON** — top insights, recent errors **with fault classification** (code, origin, kind, cause, hints), a fault-code histogram, slow traces, leak verdict. The token-efficient entry point |
| `debug-requests` / `debug-request` | Recent traces (server-side filtered) / one full trace: span tree, waterfall, queries, redacted headers, stack |
| `debug-replay` | Re-issue a stored request through the live server |
| `debug-logs` | Structured logs by level/text/trace; `persisted: true` reads the SQLite archive |
| `debug-metrics` | Per-route aggregates + gauges; `format: "prometheus"` returns raw exposition |
| `debug-diagnostics` | Leak findings with evidence; `gc: true` forces a collection first |
| `debug-history` | Persisted traces across restarts |
| `debug-events` / `debug-event-publish` | The unified event buffer (NATS + nova), publish probe events |
| `debug-state` / `debug-system` / `debug-clients` | App/process snapshot · CPU/RSS/heap profile · published SDK state |
| `debug-kt` | The "how this app works" markdown — instant onboarding |

Typical flow: `debug-summary` → spot the error → `debug-request` for the
spans → `debug-replay` to reproduce → `debug-diagnostics` for correlated
evidence.

## Production impact: zero

Three layers guarantee a production build never pays for the bar:

1. **Build-time elimination** — `ignex build` is production-shaped by
   default: the compiler proves every reachable `debugbar()` can never boot
   and **removes it from the bundle** — the dashboard SPA, observatory
   endpoints, and trace store (megabytes) are tree-shaken out. `--dev`
   keeps a dev-shaped artifact; `IGNEX_DEBUG=1` at build time is the only
   explicit opt-in that keeps the toolbar in production.
2. **Runtime self-elimination** — a disabled `debugbar()` marks itself
   `__ignexDevOnly`; the compiled server filters it from the lifecycle at
   boot. An `enabled: true` instance cannot switch on inside a prod process
   without `IGNEX_DEBUG=1`.
3. **Zero-cost context** — `ctx.debug` is a prototype getter returning a
   shared no-op; production contexts carry no extra field.

Verify it: build with `NODE_ENV=production`, boot, `GET /__debugbar/` → 404
with normal routes unaffected.

## Options

```ts
debugbar({
  path: "/__debugbar", // mount path
  maxTraces: 500, // in-memory ring buffer
  captureBody: true, // request + response bodies (256 KiB cap each)
  systemSampleMs: 1000, // CPU/memory sampling (0 = off)
  token: "secret", // x-debugbar-token header / HttpOnly cookie — never query strings
  serviceName: "my-api",
  manifestPaths: ["dist/manifest.json"], // AOT route map for KT
  docsPaths: ["docs", "."], // KT documentation scan roots
  nats: { url: "nats://localhost:4222", subjects: ["events.>"] },
  logs: { console: true, maxRecords: 2000 },
  persist: {
    path: ".ignex/observatory.db",
    maxAgeSec: 7 * 24 * 3600,
    maxRows: 100_000,
  }, // persist: false disables
  data: { nova: () => nova.server }, // realtime probe (Events panel)
})
```

With `token` set, the dashboard authenticates via a one-time
`/__debugbar/?token=…` handshake: constant-time validation, an HttpOnly
`Secure` cookie scoped to the mount, then a redirect to the token-less path
— the token never persists in URLs, access logs, or referrers.

## Where to next

- [Errors](./errors) — the fault taxonomy the Errors view renders.
- [Realtime](./realtime) — the nova FlatBuffer wire the Events panel shows.
- [CLI reference](./cli) — `ignex mcp`, `ignex dev:debug`, and friends.
