# Changelog

All notable changes to the ignex monorepo are documented here, grouped by
release. Follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions adhere to [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`ignex event bus` output now compiles and runs out of the box** (DX
  dogfood findings — see `docs/dx-improvement-plan.md`):
  - Scaffolds the wire contract (`src/realtime.ts`), a pre-wired
    `src/realtime.plugin.ts` (`novaPlugin` with the events layer + generated
    `bindings`), the typed facade re-export (`src/lib/events.ts`), the publish
    route, and a consumer whose `on()` no longer returns `off` (the global
    `on` returns `void`) — the previous scaffold failed `tsc` and 500'd at
    runtime (`no events hub bound`, `unknown event`).
  - `ignex event bus` now also adds `.ignex/sdk` to the app's `tsconfig`
    `include` and generates the local realtime SDK immediately.
  - `--features sse` route template fixed: `sse()` takes the generator, not a
    thunk (the scaffolded route previously failed typecheck).
  - Scaffold `biome.json` uses the Biome 2.x `assist` shape (the old
    `organizeImports` top-level key made `biome check` error on every new app).
- **`ignex build` regenerates the local realtime SDK before compiling**
  (`writeRealtimeSdk` — realtime-only codegen that needs no prior build
  artifacts). The compiled server imports the generated wire stack, so a
  build that ran before `ignex sdk` used to embed a STALE wire stack and
  frames decoded silently wrong (observed: string fields coming back empty);
  `ignex dev` inherits the fix via `buildProject`.

### Added

- **Typed server-side realtime facade** in the generated SDK
  (`realtime/server.ts`): `emit`/`emitToUser`/`emitToGroup`/`emitToClient`/
  `emitToTopic`/`on`/`once`/`off` typed against the app's events — no more
  `as never` casts for custom event names in routes/jobs/plugins. Re-exported
  from the package barrel and from the scaffolded `src/lib/events.ts`.
- **`novaPlugin` enables the events layer by default** (`events: {}` unless
  overridden) and exposes the events hub on the typed plugin surface
  (`plugin.server.events`), removing the "no events hub bound" footgun.
- `compiler/sdk` exports `writeRealtimeSdk` (+ `realtimeInputOf`) for
  realtime-only SDK generation without build artifacts.
- **Backend event consumers auto-register.** `ignex event bus <name>` now
  scaffolds its example consumer into the conventional `src/realtime/consumers/`
  dir (default `realtimeConsumersDir`) as a module default-exporting
  `register()`; the compiled server imports every module there and calls
  `register()` right after the plugin-init loop (guarded on a `nova` plugin
  being present), so receiving events in the backend needs no manual
  post-`realtimePlugin` plugin or ordering — the scaffolded consumer is no
  longer a hand-wired `start…Consumers()` module under `src/modules/events/`.
- **`ignex event bus` is now interactive and additive.** Instead of blindly
  scaffolding the full stack on every run, the wizard asks what to generate
  (consumer-only, consumer + publish route, or publish route only — with
  optimized defaults: full stack on a fresh app, consumer on an existing
  contract) and always asks for the event name. When `src/realtime.ts`
  already exists, a new event is **merged into the existing contract**
  (`cli/utils/realtime-merge.ts`) rather than skipped/overwritten — a second
  run no longer leaves a consumer or emit route referencing an event the
  typed facade doesn't know (the `TS2345` drift seen when scaffolding a
  second bus into an app that already declared an event).
- **Debugbar Events panel: realtime (WS) traffic joined the event buffer**
  (`@ignex/core`). The Events view is now a **unified buffer** that
  interleaves NATS pub/sub rows and the nova transport's trace rows, so you
  can see what the app **sent** (server→client emits/publishes) and what it
  **received** (frames from a WS client, a remote instance, or the NATS
  bridge) side by side in one place:
  - Every row shows an in/out direction pill, a source tag (NATS/NOVA), the
    precise kind (`publish`/`emit`/`client`/`remote`/`bridge`), the wire
    event name + → target key, byte size and a payload preview; stat cards
    are per source, filtering covers both sources, and `✕ clear buffer` drops
    both the NATS rows and the nova trace ring (`GET /api/events` +
    `POST /api/events/clear`).
  - Wire it with `debugbar({ data: { nova: () => nova.server } })` next to
    your `novaPlugin`, and `novaPlugin({ trace: { capturePayloadChars } })` to
    get payload previews (the panel surfaces a hint when capture is off). See
    `docs/debugbar.md`.
- **Debugbar Events panel: fire realtime events manually for testing**
  (`@ignex/core`). The view gains an **Emit realtime event (nova)** composer
  next to the NATS publish composer — type a wire event name + JSON payload
  (optionally a `user:u-42` / `group:` / `topic:` / `client:` target) and
  `POST /api/nova/events/emit` routes it through the nova events hub, so
  **server-side consumers AND subscribed clients receive it** (a broadcast
  emit, or targeted). Unregistered names surface the hub error back in the
  composer. Same dev-only lifecycle as the rest of the debugbar: the new
  endpoint + UI live inside the debugbar's serving graph, which a
  production-shaped build eliminates (the compiled-server tests now assert the
  production artifact contains no `nova/events/emit` / event-buffer code).

### Changed

- **CLI remapped onto a typed, modern dispatch core** (`@ignex/cli`).
  Every command is now a citty (`defineCommand`) definition with a typed
  `argsDef` — one source of truth for parsing, `--help` rendering, and shell
  completions — instead of hand-rolled `node:util` parseArgs call sites:
  - **Typed args everywhere** — `parseArgs<typeof argsDef>` gives each
    command correctly-typed parsed values (flags, positionals, kebab/camel
    aliases), and citty's native `--no-` negation replaced the old literal
    `no-spawn`/`no-install` key hacks (`dev --no-spawn`, `create --no-git`,
    `ops --no-mongo`, `ops --no-replica`).
  - **Help that can't drift** — root help is a branded, grouped command
    table from a single registry (`commands/registry.ts`); per-command help
    is citty's usage rendered from the same typed args plus a curated
    EXAMPLES section. Unknown commands get "did you mean" typo recovery.
  - **Completions rebuilt on the args definitions** — `utils/completion.ts`
    derives flags and enumerable values (`valueHint`, `--features`, methods,
    hook stages, ops targets) from the typed args, replacing the old
    help-text regex scraping; the hidden `_complete` backend is dispatched
    through the same citty app.
  - **Lazy loading preserved** — `commands/loaders.ts` dynamic-imports each
    command, so `ignex` boots without pulling compiler/core/mcp stacks.
  - All commands keep their legacy `runX(argv)` entry points (tests and
    internal delegations), and `ignex dev --open` now actually opens the
    browser once the spawned server answers.
- **Debugbar: the dashboard is now a prebuilt signal-based SPA with a live
  SSE stream** (`@ignex/core`). Same panels, same endpoints, same
  zero-dependency posture — rebuilt for maintainability, UX and speed:
  - **SPA source instead of embedded strings** — the dashboard moved from a
    1,401-line JS string + 606-line CSS string inside `debug/dashboard-*.ts`
    to real SolidJS + Tailwind modules under `packages/core/src/debug/ui/`
    (one JSX component per panel behind a hash router, shared widgets, and a
    keyed-identity merge that keeps `<For>` rows stable across live bumps —
    Solid's fine-grained reactivity means a new trace inserts one `<tr>`, not
    an innerHTML diff). The design system is a Tailwind input (`ui/styles.css`:
    token palette switched by `data-theme` + `@theme` utility mappings).
    Bundled AOT by `scripts/gen-debug-ui.ts` (babel-preset-solid +
    @babel/preset-typescript → `@tailwindcss/cli` → `Bun.build`) into the
    committed content-hashed `dashboard-client.gen.ts`; CI staleness gate
    (`check:debug-ui`, part of `verify:quick`) keeps sources and artifact in
    sync. Packages remain source-only with no runtime build step.
  - **Live updates replace blind polling** — a Server-Sent-Events revision
    stream (`GET /api/stream`, authenticated via single-use short-TTL tickets
    from `POST /api/stream/ticket`) pushes per-domain mutation counters so an
    open dashboard refetches only what changed; a new trace inserts one keyed
    table row instead of rebuilding whole views (fine-grained DOM bindings,
    no innerHTML diffing). Automatic fallback to 5 s polling. Store/log/NATS
    classes accept an optional `onNotify` hook that feeds the counters.
  - **Serving layer decomposed** — the 1,445-line plugin is now a composition
    root over `debug/server/`: `auth.ts` (constant-time token gate + page
    handshake), `assets.ts` (precomputed shell under a strict CSP —
    `default-src 'none'` — and content-hash ETags so reloads revalidate with
    304s), `endpoints.ts` (ONE declarative endpoint table driving both AOT
    dispatch and interpreted router registration — the previously
    hand-duplicated route list cannot drift anymore), and domain handler
    modules. The plugin file itself shrank to options + lifecycle.
  - **UX** — every panel deep-links (`#/requests/<id>/waterfall`, …), the
    browser back button works, detail links resolve live-ring traces first
    then persisted history (bookmarks survive restarts).
  - Endpoint contract is unchanged (the MCP debugger needs no changes); new
    additions are only the two stream endpoints. See docs/debugbar.md.
- **`ignex build` is production-shaped by default** (`@ignex/cli`,
  `@ignex/compiler`). The deploy-artifact command now sets the compiler's new
  explicit `production: true` option unless `--dev` is passed, so a production
  artifact no longer depends on the build shell exporting `NODE_ENV=production`:
  - the debugbar dashboard, observatory stack and per-request tracing
    instrumentation are eliminated at build time, every AOT optimization the
    debugbar would have disabled stays on, and `globalThis.__IGNEX_PROD_BUILD`
    is baked into the artifact — launching it with `NODE_ENV` unset cannot
    re-enable dev tooling;
  - the TLS policy is baked from the build shape: prod-shaped artifacts never
    auto-generate dev certificates (mkcert/openssl) — they warn and fall back
    to HTTP/1 like any other production process;
  - the dev build-error overlay marker probe is const-folded out of
    prod-shaped artifacts (previously an unmatched-route fs probe when
    launched without `NODE_ENV`);
  - `exposeErrorDetails` now defaults to `false` under any production shape
    (`production`, `compile`, or `NODE_ENV=production`) — an artifact built in
    a shell without `NODE_ENV` no longer ships error details to clients. An
    explicit option still wins.
  `IGNEX_DEBUG=1` at build time keeps the toolbar inside an otherwise
  production-shaped build; `--dev` emits a dev-shaped artifact (warned).
  Config-driven builds can set `production: true` directly. Cache fingerprint
  includes the new option; `COMPILER_CACHE_VERSION` bumped.

### Added

- **Observatory: the debugger becomes a full introspection tool** (`@ignex/core`
  debugbar + `@ignex/mcp`). On top of the request waterfall/replay, the
  debugbar now ships five new panels and APIs:
  - **Structured logs** — `ctx.debug.log(level, message, attrs)` /
    `debugLog()` (ALS-correlated to the active request trace) plus opt-out
    console mirroring; level/text/time/trace filters at `GET /api/logs`.
  - **Local SQLite persistence** (`persist.ts`, via the existing
    `bun:sqlite` loader — zero new dependencies): finalized traces, spans,
    logs and system samples batch-write (1s flush) to a WAL-mode db at
    `.ignex/observatory.db` with 7-day/100k-row retention pruning. History
    survives restarts — `GET /api/history` (+ `/api/history/:id`
    reconstruction) powers post-mortems; `debugbar({ persist })` tunes or
    disables it.
  - **Metrics + Prometheus/Grafana** (`metrics.ts`) — per-route
    request/error counters, status families and duration histograms with
    p50/p95/p99 estimates, system gauges fed by a new
    `SystemProfiler({ onSample })` hook; JSON snapshot at `GET /api/metrics`
    and standard text exposition at `GET /api/metrics/prometheus`
    (`ignex_http_requests_total{route}`, `ignex_http_request_duration_ms_*`,
    …) so any Prometheus scraper/Grafana board can consume ignex directly.
  - **Leak diagnostics** (`leaks.ts`) — pure analyzer over profiler samples:
    heap/RSS least-squares growth trends gated by R² (warning ≥0.5
    MiB/min → critical ≥4), event-loop p95 saturation and never-draining
    in-flight requests; every finding carries measured evidence +
    recommendation. Served at `GET /api/diagnostics`; `POST
    /api/diagnostics/gc` forces a collection and reports freed MiB.
  - **App-state snapshot** (`state.ts`) — runtime/memory facts,
    env-var NAMES (values never exposed), route/plugin inventory and
    feature flags at `GET /api/state`.
  -   Dashboard gains Logs / History / Metrics / Diagnostics / State views
    (keys `0–9`, pausable live refresh); MCP adds `debug-logs`,
    `debug-metrics` (`format: prometheus`), `debug-diagnostics` (`gc`),
    `debug-state` and `debug-history`; `ai/summary` now embeds an
    `observatory` block (verdict, recent warnings, persist state).
  Docs: `docs/debugbar.md` (observatory sections).
- **KT page becomes a real onboarding doc** (`@ignex/core` debugbar). The
  knowledge-transfer page now answers "where is everything and what does this
  app actually do" for a new developer (human or agent):
  - **Where things live** — conventional app directories (`src/routes`,
    `src/models`, `src/middleware`, `src/hooks`, `src/views`, `src/config`,
    `src/lib`, db folders) are probed on disk and listed with their contents
    and purpose, plus the route-file conventions.
  - **Documentation inventory** — every markdown doc in the repo with its
    title (extracted from the first heading; README first). Scan roots are
    configurable via `debugbar({ docsPaths })` (default `["docs", "."]`),
    rooted at the new `projectRoot` option.
  - **Database activity** — all `db` spans across the retained request traces
    aggregated into normalized statement patterns (literals → `?`) with
    action verb, table, call count, total time and the routes that ran them:
    what each route *actually* does to the database, per request window.
  - New exports: `summarizeDbActivity`, `scanProjectAreas`,
    `scanDocsInventory`; `AppKnowledge` grows `areas`, `docs`, `dbActions`;
    `buildAppKnowledge` accepts a `traces` input (the debugbar plugin feeds
    its trace store automatically).
- **Dashboard UX polish pass** (`@ignex/core` debugbar): the SPA is restyled
  for long sessions — layered background wash, glassy sticky top bar, sticky
  table headers under it, hover row accents with a left indicator stripe,
  tabular numerals, lifted stat cards, gradient primary buttons, thin
  scrollbars, `focus-visible` rings, refined empty states and a one-shot
  flash on freshly-arrived trace rows. The KT view is now rendered from the
  structured knowledge JSON as a real product surface (hero band + runtime
  chips, stat strip, project-map card grid with click-to-copy paths, request
  stage pipeline, verb-badged DB activity table with call bars and route
  chips, docs inventory, SDK card) with markdown fallback for older payloads.
  Docs: `docs/debugbar.md` (KT section).
- **Wire-level MongoDB capture** (`@ignex/core/debug`): new
  `instrumentMongoClient(client)` hooks the driver's command monitor so every
  actual round-trip inside a traced request is recorded as a `db` span with
  WHAT WAS SENT (full wire command: filter/projection/documents), WHAT WAS
  RECEIVED (reply preview) and the driver-reported duration — independent of
  ORM-level instrumentation. Commands fired inside an open `db` span nest
  under it (`find app.gigs` beneath the logical `gigs.find`); nested db spans
  are excluded from the per-request `dbCount`/`dbTimeMs` aggregates so totals
  stay truthful. Enable before connections open — pooled connections snapshot
  the flag at construction. `debugQuery()`/`ctx.debug.query()` now also
  record non-array payloads (object filter/options documents) verbatim as
  `params`. The reference app captures its ORM calls at the `db.ts` proxy
  boundary (`gigs.paginateFlexible` spans with full call args + result
  preview) when `DEBUG=true`.
- **Log detail view + endpoint**: clicking a Logs-panel row opens the full
  record — message, structured fields, level/source/time and request
  correlation with an "open request ↗" jump — served by the new
  `GET /api/logs/:id` (`LogStore.getById`). The trace link on log rows now
  lands on the owning request's **Waterfall** tab (matching the docs) and
  preserves the row source, so jumps from SQLite-persisted history resolve
  through `/api/history/:id` instead of 404ing against the live ring.

### Changed

- **Enterprise hardening pass (sessions, JWTs, bodies, transport).**
  - **Session secrets are guarded everywhere, not just in production.**
    `createSessionManager` now enforces the strength floor (≥16 chars, no
    known dev default) whenever `NODE_ENV` is `production` OR UNSET — the
    common staging shape (`bun dist/__server.js` with no environment wiring)
    previously booted with forgeable session cookies. Explicit
    `NODE_ENV=development|test` stays lenient; `IGNEX_ALLOW_WEAK_SECRET=1`
    bypasses with a loud warning. Scaffolds stop shipping a known literal:
    new `devSessionSecret()` (`@ignex/core`) generates a strong per-machine
    secret persisted at `.ignex/dev-session-secret` (0600), used by the app
    config and the CLI templates when `SESSION_SECRET` is unset.
  - **Non-expiring JWTs fail loudly.** `jwtVerify`/`jwtVerifyEdDsa` (HS256 +
    EdDSA, wrapper-level so native and fallback agree) now REJECT tokens
    without an `exp` claim by default — `{ requireExp: false }` opts out
    explicitly. `createJwt`/`createEd25519Jwt` warn once at construction when
    created without a TTL; `createAuthModule` defaults issued-token lifetime
    to 3600s (`DEFAULT_AUTH_TOKEN_TTL_SECONDS`, opt out with
    `ttlSeconds: 0`). A config omission can no longer silently mint permanent
    credentials.
  - **Session-id rotation API** (`session.rotate()`): fixation defense for
    login/privilege-change flows — mints a fresh id, preserves data + expiry,
    rewrites the cookie and deletes the old store row (store-backed replays of
    the old cookie resolve to null and clear it; purely stateless cookies stay
    irrevocable by design).
  - **Chunked request bodies are bounded mid-stream on the interpreted path.**
    `ctx.body.json()/text()/arrayBuffer()/blob()` and urlencoded form parsing
    route chunked bodies (no content-length) through `readBodyBounded()`,
    which 413s the moment the running total exceeds the per-kind limit —
    Bun's parsers previously buffered the whole stream (up to the server body
    cap) before the post-parse guard could run.
  - **Deliberate serve limits instead of inherited ones.** Interpreted
    `serve()` applies `DEFAULT_MAX_REQUEST_BODY_SIZE` (64MB) when the app
    doesn't set one, injects `websocket.maxPayloadLength`
    (`DEFAULT_WS_MAX_PAYLOAD_LENGTH`, 4MB) without mutating the caller's
    handler object, and the compiled bootstrap emits the same constants
    (compiler option default no longer hardcodes 128MB).
  - **File responses set `x-content-type-options: nosniff`** (`sendFile`,
    `streamDownload`) and `safeJoin` is symlink-hardened: root + target are
    resolved to real paths, so a symlink inside the root pointing OUTSIDE is
    rejected (the old lexical check served it).
  - **Proxy trust-boundary hygiene**: `forwardRequest` strips client-supplied
    `x-forwarded-for`/`-host`/`-proto` before crossing upstream (log/authz
    poisoning vector); `preserveForwardedHeaders: true` opts back in.
  - **SSE backpressure**: the event loop pauses pulling from the generator
    while the stream's desired size is non-positive (slow consumer) and tears
    the generator down after ~1s of sustained zero-drain backlog, releasing
    its timers/loops instead of queueing unboundedly.
  - **Config-less apps drain on shutdown too.** The generated server's
    SIGTERM/SIGINT handler always stops accepting connections and lets
    in-flight requests finish (`stop(false)`); only plugin closing remains
    app-config-conditional, with a 10s unref'd force-exit deadline. Rolling
    deploys no longer kill requests for apps without an app config.
  - **CI covers every platform**: quality gates (typecheck, lint, tests,
    AOT build, both smoke modes) run on Linux/macOS/Windows; native parity
    builds castrum FROM SOURCE on each OS and discovers the platform binary
    generically (non-Linux lanes advisory until castrum publishes those
    targets — flip to blocking once green). Server-bench regression stays
    Linux-only (committed baseline is machine-specific).

- **Native-flow hardening pass (memory safety + DoS bounds).** Packed-wire
  decoders (`@ignex/native` `packed.ts`, route-wire result decode) now
  VALIDATE every length/count against the buffer before reading — under Bun
  the ffi readers dereference raw pointers, so a corrupt/hostile wire could
  read adjacent process memory (uncatchable SIGSEGV); malformed wires now
  fail fast with `PackedWireError` and the request-level callers fall back to
  the byte-parity JS path (route prelude catch / ingress fault policy).
  The compiled native body prelude (`@ignex/compiler`) reads via the new
  `readBodyBounded()` (`@ignex/core`) instead of an unbounded
  `req.arrayBuffer()`: content-length pre-check + incremental chunked cap —
  an adversarial chunked request can no longer buffer up to Bun's server cap
  per in-flight request on routes whose real limit is `maxJsonBytes`; a
  native 413 verdict now throws `BodyParseError(413)` directly instead of
  re-parsing through the JS path. Ingress verdicts are completeness-checked
  before decode: a short-but-nonzero write used to decode STALE pooled
  fields (previous request's status/rate-limit numbers bleeding into the
  response); it is now treated as a fault (degradation + fail-closed/open
  policy). The rate-limiter fallback eviction is amortized O(1): the old
  shape scanned the WHOLE map on every overflow insert (a unique-IP flood
  pinned ~1M entries AND turned every check into a full-map scan).
- **Silent native degradations are now observable.** Addon load failures,
  auto-mode ffi bind/self-test failures and route-surface absence report
  through the telemetry sink (previously debug-gated or bare console.warn);
  degradation events are ALWAYS counted — `degradationCounts()` /
  `degradationTotal()` (re-exported from `@ignex/core`) expose the full
  magnitude even when the default one-line-per-op console sink has fired.
  Route compile failures diagnose precisely: "addon exports castrum_route_*
  but rejected the descriptor" (ROUTE_DESC_VERSION skew) is distinct from
  "surface absent". The fused session ops get a bind-time seal→open
  self-test plus fully bounds-checked wire decoding (`sessionOpen` returns
  null on a short/lying wire instead of decoding adjacent memory).

### Added

- **Typed crypto batch wrappers** (`@ignex/native`, re-exported from
  `@ignex/core`): `signCookieBatch`/`verifyCookieBatch` (n≥4), `csrfVerifyBatch`
  (n≥16, ~4×), `hmacSha256Batch`/`hmacSha256VerifyBatch` (n≥4/n≥16) — the
  measured bulk winners that previously existed only as raw addon symbols.
  Below threshold or without the addon each is a plain loop over the proven
  scalar impls; parity is asserted on both paths. Validated unpackers
  (`unpackByteItems`, `unpackBitset`, …) and `PackedWireError` are exported
  for batch consumers.
- **Lean native-stack responder is first-class** (`nativeRouteHandler` +
  `NativeRouteSnapshot` re-exported from `@ignex/core`): wrap a compiled
  route as a raw Bun.serve handler running ONE native call per request —
  for apps/framework embedders where the framework owns parse + verdict and
  lifecycle stages are handled elsewhere.

### Changed

- **Static-route promotion to Bun's native router** (`@ignex/compiler`):
  constant-hoisted GET routes are now emitted as a single pre-built frozen
  `Response` bound directly as the route-table VALUE (`GET: STATIC_RES_<ref>`)
  instead of a wrapper + per-request `new Response`. Bun serves such routes
  entirely in Rust — zero per-request JS — with native auto-HEAD (body
  stripped, status/content-length preserved) and free conditional-GET handling
  when an ETag is present. Unmatched methods still fall through to
  `__fallback` (405 + `Allow`, unchanged). Heat-capture builds keep the legacy
  handler emission so dev request counting keeps working.
  Requires `COMPILER_CACHE_VERSION` bump (0.9.2 → 0.9.3).
- **Header materialization fast path** (`@ignex/core`, compiler preludes): new
  `headersToRecord()` uses Bun's native `headers.toJSON()` (~5× faster than
  `Object.fromEntries(headers.entries())`) and is now used by the generated
  headers-validation prelude, the interpreted `validateSchema`, and
  `defineRequest`.
- **Allocation-free session reads** (`@ignex/core/security/session`): the
  middleware reads the session id via a new byte-compatible single-cookie
  scanner (`readRequestCookie`) instead of indexing the lazy cookie jar, so
  cookie-less requests no longer materialize the jar proxy or parse the whole
  header; lazy-creation markers moved from `ctx.state` (forced Map alloc) to a
  module WeakMap keyed by context. `getSession` still honors the legacy state
  marker.
- **Promise-free no-op debug API** (`@ignex/core/debug`): `NOOP_DEBUG_API.span/
  query/http` and the `debugSpan`/`debugQuery` free functions no longer
  allocate Promises when no trace is active — routes that call `ctx.debug.*`
  unconditionally stay microtask-free in production.
- **Compression plugin hoists**: the supported-encoding list is built once at
  plugin construction instead of every response.

### Changed

- **Size-gated native dispatch** (`@ignex/native`): ops can now route per call
  on measured input-size crossovers instead of one static decision.
  `SIZE_GATES`/`sizeGateAllowsNative()` (selection.ts) + calibration harness
  `scripts/bench-size-crossover.ts`. Measured sweep (0B→256KB, median of
  interleaved trials): `jsonValid` is gated at 256B — the previous always-
  native dispatch lost 20–40% on sub-64B inputs; `hmacSha256` shows NO clean
  crossover (left static); `fnv1a64` is natively dominant from 32B; session
  seal/open never beat JS below ~1KB (open loses at every size) — confirming
  the opt-in-only wiring. Kill switch: `IGNEX_SIZE_GATES=off`. Gate decisions
  are performance-only; byte-parity across thresholds is asserted in tests.

### Changed

- **Enterprise-hardening pass: observability, multi-process safety, DoS caps.**
  Native layer (`@ignex/native`): every degradation is now OBSERVABLE via
  `setNativeTelemetrySink()`/`reportDegradation` (ingress faults, route-run
  errors — previously swallowed — loader failures, argon2id↔scrypt backend
  downgrades that silently returned `false`); the ingress pipeline supports
  fail-closed mode (`runtime.failClosed` / `IGNEX_INGRESS_FAIL_CLOSED=1`,
  503 instead of silent pass-through); JS gzip/brotli fallbacks enforce the
  same 64 MiB decompression-bomb cap as the Rust core
  (`PayloadTooLargeError`, `maxOutputBytes` override); new
  `passwordHashAlgorithm()`/`canVerifyPasswordHash()` diagnostics; the FFI
  bind + ~40-op parity self-test warm at boot via `warmRuntime()` (kills the
  first-request latency spike); `effectiveImplFor(op)` exposes what ACTUALLY
  runs vs the static `SELECTION` table. Core runtime: durable jobs are now
  multi-process safe (fresh read-modify-write per op — no more stale-snapshot
  double claims; random owner-token leases verified on complete/fail/heartbeat;
  per-job `claimOne`; collision-resistant ids; `retention` pruning of finished
  history; `openStoreJobStore()` accepts ASYNC drivers, making Redis-backed
  queues actually constructible — previously they threw at construction);
  rate limiting gained atomic shared counting (`createRedisRateLimitStore()`
  fixed-window INCR) and an explicit store-failure policy
  (`onStoreError: "open" | "closed"` — previously unhandled rejections);
  readiness probes (`healthProbe()` plugin + `runReadinessChecks()` for AOT
  file routes) separate liveness from dependency-aware `/ready` (503 on
  failure); SQLite driver enables WAL + busy_timeout + synchronous=NORMAL;
  memory/file stores bound entries (`maxEntries`, expired-first eviction);
  file store supports coalesced writes (`writeCoalesceMs`); sessions opt into
  fused native seal/open (`nativeFusion: true` — default remains the measured-
  faster JS two-step); the scheduler records failed tick jobs as FAILED (it
  previously marked them completed), claims only its own job id, and logs
  swallowed store-write errors; notifier mail failures are logged, not
  dropped; interpreted-app shutdown drains by default matching the generated
  server, whose SIGTERM handler was FIXED to drain (`stop(false)` — it called
  `stop(true)` and force-closed in-flight requests while claiming to drain).
  The reference app ships a real `/ready` route pinging Mongo. 42 new tests.

### Changed

- **Native capability surface expanded** (`@ignex/native`): new
  `sessionSeal`/`sessionOpen` (fused envelope JSON + HMAC in one crossing),
  `createSchemaValidator(...).innerHandle` + `schemaQueryValidate` /
  `schemaCookieValidate` (fused wire-level parse+validate), and
  `metricsRecordBatch` (N metric events per crossing). All are parity-tested
  against the pure-TS fallbacks and degrade to `null`/`false` when ffi is
  off. **A/B verdict**: at current call granularity these measure
  neutral-to-slower than the optimized JS paths they'd replace — session
  seal 0.80x / open 0.58x (JSC's JSON.stringify beats the multi-cstring
  transcode on small envelopes), wire-level gate 0.93x (parse dominates both
  paths) — so the request-path defaults remain the measured-fastest JS
  implementations; the native ops ship as capabilities for callers whose
  granularity differs (batched events, non-JSC hosts). The metrics hint-lane
  (~21×) and brotli/native-query wins from this release ARE wired into the
  hot paths.

### Changed

- **Metrics: Prometheus data-model fix + native registry option**
  (`@ignex/native` `createMetricsRegistry` / `createNativeMetricsRegistry` /
  `createMetricsRegistryFallback` / `decodeMetricsSnapshot`, backed by
  castrum's sharded registry with a packed v1 **snapshot dump** for OTLP-style
  export). The registry now ENFORCES the Prometheus data model (one label
  shape per metric name), so `metricsPlugin` emits
  `ignex_http_requests_total{route,status}` /
  `ignex_http_errors_total{route,status}` / labeled duration histograms
  instead of mixing unlabeled + labeled series under one name (which scrapers
  reject); render includes standard `# TYPE` headers. `@ignex/core`'s
  request-path default remains the optimized pure-TS registry, while the
  native registry serves Rust-side state, Rust render, and snapshot export.
- **Metrics hot lane: hint-addressed series** (`hint` param on
  `counter()`/`histogram()` across all three backends — core registry, native
  C-ABI/NAPI wrapper, pure-TS fallback): the caller passes a stable per-series
  address composed from the label VALUES, replacing per-event label-key
  construction with one Map hit + prebuilt state. The metricsPlugin's
  per-request accounting (requests + errors + duration) drops from
  **~1150ns to ~55ns (~21×)**; a single labeled counter event is ~9ns.
  Labels are captured from the first call bearing each hint; the generic
  (no-hint) lane is unchanged.
- **Performance: interpreted-path hot-loop optimizations** (all parity-gated
  under `IGNEX_NATIVE=off`; 833 core tests + both smoke gates green):
  - **Brotli compresses in Rust when the addon is loaded** — the buffered
    brotli response path piped already-in-memory bytes through
    `CompressionStream` (async Web-stream chunking); measured **~292× faster**
    on a 40 KB JSON body on Bun 1.4.1-canary (119ms → 0.4ms). gzip behavior
    unchanged; deflate and unknown-size streams keep the streaming fallback.
  - **Interpreted `ctx.query` uses the native pairs parse** +
    `NativeQueryParams` (the same facade compiled routes use): measured
    ~2× faster parse+read on a 10-parameter query (~1.98µs → ~1.16µs), with
    the URLSearchParams fallback preserved when the addon is absent.
    `validateSchema` now assigns through the `ctx.query` setter instead of
    `Object.defineProperty` (~8× on that line, per the prelude's own bench).
  - **Cookie jar views are cached per key** (`createCookieJar` /
    `createLazyCookieJar`): reading `ctx.cookie[name]` no longer allocates a
    fresh object + spread per access — session/CSRF reads (every request when
    the session plugin is on) now allocate zero. Observably identical: views
    re-read the stores on every property access.
  - **Metrics registry hot path**: label keys sort with plain `<` instead of
    `localeCompare`, Counter/Histogram views are cached per series (no
    closure allocation per event), histogram observe scans buckets once
    ascending. Counter+inc: 805ns → 693ns; render output byte-identical.
  - **`/openapi.json` memoizes its serialized document** (stringified once
    per route-count revision, not per request).

### Added


- **Maintainability: knip dead-code gate** — `bun run check:dead` (config in
  `knip.json`) now detects unused files, exports, dependencies and duplicates
  repo-wide and is part of `bun run verify`. Tuned to ignore dynamically
  spawned bench servers, the matrix test fixtures (file-convention routes) and
  deliberate public-API type surfaces (`@ignex/native` execution backend,
  `csrfToken`/`csrfVerify`). The initial sweep removed 10 dead files (unused
  domain barrels in `core`, `codegen/routes/index.ts`, `cli/utils/spinner.ts`,
  stale debug/bench scripts) and ~50 dead exports/re-exports — facade barrels
  (`ir`, `phases/analysis`, `phases/codegen`, `utils/ast`) now export only what
  is actually consumed, so every symbol has exactly one canonical import path.
- Dependency hygiene: `@ignex/native` declared where used (`compiler`),
  `@ignex/test-utils` declared by its consumers (`core`, `native`),
  `@ignex/core` moved to compiler devDependencies (test-only via vitest
  aliases), unused root/app deps removed (`drizzle-kit`, root `@ignex/ninox`,
  app `@ignex/cli`).
- **Compiler: dispatch-shell specialization + dev heat capture (PGO)** —
  per-route wrapper variants chosen at build time (`__wrapStatic` drops the
  wildcard block + per-request URL parse; `__wrapStaticSync` drops the Promise
  funnel for sync/constant routes; wildcards/WS keep the generic `__wrap`),
  build-time auto-HEAD handlers for constant GETs (bound directly, no GET
  re-run), and a dev-only per-route request counter (`ignex dev`, opt-out
  `--no-heat`) flushed to `<outDir>/hot-routes.json` that the analysis phase
  merges log-scaled into `hotnessScore` — inline-budget priority and
  dedup-leader choice are now profile-guided. `COMPILER_CACHE_VERSION`
  → 0.9.1. See `docs/performance-baseline-2026-08.md` Round 16.

### Fixed

- **Debugbar observability accuracy pass** (each with regression coverage):
  - **CPU% was inflated exactly 10×** — `SystemProfiler.sample` multiplied
    the CPU-ms/wall-ms ratio by 1000 instead of 100 (`system.ts`), so a
    saturated core reported ~1000%. Correct percent-of-one-core now,
    verified empirically (1043.7% → 104.4% on the same workload).
  - **Trace/sample timestamps were monotonic uptime, not wall clock** —
    request rows rendered 1970-era times in the dashboard, SQLite pruning
    deleted every persisted row against epoch cutoffs, history
    `since`/`until` filters never matched and samples collided across
    restarts. The wire types (`RequestTrace.ts`/`.startedAtMs`,
    `SystemSample.ts`) now carry epoch ms; monotonic timing stays internal
    for span math only.
  - **Prometheus exposition omitted the process-CPU series** —
    `ignex_process_cpu_pct` is now exported next to the RSS/heap/loop
    gauges.
  - **Log/console capture cloned the whole span tree per record** —
    `debugLog()`/`console.*` called `trace.toJSON()` (full span copy) to
    read two fields; they read them directly now.
  - **Cache spans lied twice** — `ctx.debug.cache(hit, label)` without a
    duration left the span open (every such call finalized as a bogus
    "span left open" error row), and the caller-measured duration was
    ignored (~0 ms waterfall bars). Spans always close now and honor the
    supplied duration.
  - **The event-loop probe timer leaked** across debugbar init/close
    cycles; `close()` clears it now.
- **Debugging: error stacks and span origins remap to your TypeScript
  sources.** Bun does not apply source maps to runtime stack traces
  (verified on 1.4.1-canary), so traces captured from the compiled bundle
  pointed at minified `__server.js` coordinates. New
  `packages/core/src/debug/sourcemaps.ts` decodes v3 VLQ mappings and
  rewrites `Trace.errorStack` + span `origin` frames through the adjacent
  `.map` file (negative-cached passthrough when there is none). The
  compiler emits source maps by default (`sourceMap: true`; CLI templates
  follow), and `GET /api/requests/:id` additionally resolves the matched
  route's repo-relative `sourceFile` from the AOT manifest (rendered in
  the request meta panel). End-to-end: a throw at `out/entry.js:1:42` in
  a minified bundle remaps to the exact `orig.ts:3:13`. Captured stacks are
  also **app-first**: frames from this debug layer (`debugQuery`, …),
  `node_modules` and `node:` builtins sink below the application's own
  frames, so "where in MY code did this happen" is answered by the first
  line instead of being buried under wrapper internals.
- **Span origins pointed at core internals for helper-created spans** —
  `callerOrigin()` used a fixed `stack[3]` heuristic that assumes the span
  was started by application code directly; through `debugQuery` /
  `ctx.debug.query` / `ctx.debug.span` it produced
  `at debugQuery (.../core/src/debug/api.ts:85:22)` on every DB row. It now
  walks past ALL frames inside this debug layer before capturing, so the
  origin is the application call site (type contract on `Span.origin`
  finally honored).
- **Dashboard UI overflow pass**:
  - Error stacks were rendered into `<pre class="stack">`, colliding with
    the `.stack` status-bar rule (`display:flex; height:14px`) — stacks
    squashed into an unreadable 14 px strip. Now a dedicated
    `pre.err-stack` (wraps long frames, scrolls tall ones).
  - Wide tables scroll inside their panel (`overflow-x` on the panel — a
    `display:block`-on-table approach was tried and reverted: it corrupts
    row layout and foster-parents cell content above the header); long
    SQL / error / origin cells wrap (`td.wrap`); sent-params and result
    JSON clamp to `.q-json` (140 px previews).
  - Waterfall label column and KVs adapt below 760 px.
  - Span/query origins are click-to-copy in the waterfall, detail KVs and
    Queries table, with display truncation + full text in tooltips.
- **Internal-frame detection works inside compiled bundles** —
  `isInternalFrame` keyed on `import.meta.url`, which in a bundle is
  `.ignex/server.js`, so sourcemapped frames pointing back at core's real
  source tree (`packages/core/src/debug/…`) were misclassified as
  application frames — origins/stacks led with
  `at callerOrigin (…/tracer.ts:…)`. Detection now also matches stable
  path shapes (`packages/core/src/debug/`, `@ignex/core/`) that hold for
  workspace links, `node_modules` installs and published tarballs, and
  recognizes `at async node:` frames.

- **Security hardening pass** (core + native), each with regression tests:
  - `rateLimit`/`ctx.ip` now key on the **rightmost** `x-forwarded-for`
    entry (`lastForwardedIp`) — the entry the trusted proxy appended. The
    leftmost value is fully client-controlled, so rotating it per request
    minted unlimited fresh rate-limit buckets. `firstForwardedIp` remains
    exported but is documented as unsafe for security decisions.
  - `ctx.cache()` / `HttpResponseCache.getOrSet` bypass the cache for
    requests carrying `Authorization` (RFC 9111 §3.5) or cookies — unless
    `allowAuthorized: true`, `allowCookies: true`, or `vary: ["cookie"]`.
    The cache key does not include credentials, so authenticated responses
    could previously leak across users through a shared key.
  - The debug dashboard defaults **off** unless `NODE_ENV=development` or
    `IGNEX_DEBUG=1` (an unset/ambiguous environment previously enabled it),
    token comparisons are constant-time, and query-string tokens are only
    accepted by the page itself, which converts them into a path-scoped
    HttpOnly cookie via redirect — API calls authenticate via header/cookie,
    never a logged/referrered URL.
  - Compression no longer buffers unknown-length streams whole (an SSE or
    proxied stream previously hung the response and grew memory without
    bound) — streams compress incrementally via `CompressionStream`;
    `text/event-stream` is excluded from compression entirely.
  - scrypt verification fails closed on attacker-inflated cost parameters
    (`N > 2^20`, `r > 32`, `p > 8`, non-power-of-two `N`) instead of passing
    them to `scryptSync` — a user-supplied PHC string was a memory-exhaustion
    gadget.
  - `writeEnvKeys` writes/tightens dotenv files to mode `0600` (the auth
    module's Ed25519 bootstrap writes private keys there).
  - CSRF double-submit cookie↔header equality is constant-time.
  - Sessions clear the cookie when the store row is missing (dead ids no
    longer re-decode per request) and deletions mirror the write attributes
    (`Cookie.remove(attrs)`), so a `Path=/` session cookie is actually
    deleted; tamper-case clears get the same treatment.
  - `security()` ignores spoofable `x-forwarded-proto` for HSTS decisions
    unless `trustProxy: true`; duplicate route registrations warn (the served
    table kept the LAST handler while dispatch returned the FIRST); the
    rate-limit "anonymous" warning now says the bucket is SHARED (it claimed
    limiting was skipped).
  - `runLifecycle` applies accumulated `set` mutations on halts too —
    matching every compiled `__applySet`-on-halt return, which fixes guards
    that write a cookie/header and then halt (e.g. the CSRF bootstrap cookie
    before a 403).
- `packages/cli/test/tinker.test.ts` resolves workspace symlinks + the CLI bin
  from the test file location instead of `process.cwd()` — the suite passed
  only when vitest ran from the repo root (`bun run test`) and failed under
  `bun run test:cli`.
- Three long-standing oxlint warnings cleared (irregular whitespace in
  `check-jsdoc.ts`, unassigned `server` var in `debugbar-events.test.ts`,
  useless spread fallback in `mcp/debugger.ts`).

### Added

- **Core: nova event trace reaches the debugbar + MCP** — the debugbar gains a
  `data.nova` probe (`data: { nova: () => novaPlugin.server }`) that powers
  `GET /__debugbar/api/nova/events` (what fired in the FlatBuffer realtime
  transport — emits, publishes, client/remote/bridge inbound, newest first,
  with per-event counts and frame sizes), `POST …/nova/events/clear`, and a
  compact `nova` block in the AI summary. The MCP server registers
  `debug-nova-events` (list/filter/clear) so an agent can answer "what realtime
  events fired?" against a running app. `@ignex/nova` (>= 0.1.x) records every
  fired event into a pre-allocated structure-of-arrays ring — zero-GC on the
  hot path, `IGNEX_NOVA_TRACE=0` to disable globally.

### Changed

- **Compiler: the linker always bundles; hand-rolled helper pruning removed** —
  every build (dev included) now links through `Bun.build`: route modules,
  hooks, precompiled validators/serializers and generated helpers compile into
  one self-contained artifact with real bundler treeshaking. The string-key
  dead-code machinery (`Emitter.markUsed`/`markCore`, the `HELPERS` dependency
  tables + transitive closure, and the `treeshakeRuntime` option) is deleted —
  the bundler does this by construction. Cold boot of the reference app drops
  ~15% (≈330 ms → ≈295 ms) and the artifact shrinks even unminified (the old
  pruner kept dead weight); `minify` now only controls identifier compression.
  Unresolvable packages referenced by route code are externalized with a
  warning (resolved at runtime) instead of failing the build; standalone
  binaries (`compile: true`) still embed everything.

### Fixed

- **Compiler: opaque RBAC guards no longer degrade authorization** —
  `withGuards(handler, { permissions: PERMS.X })` with non-statically-evaluable
  guard constants used to be inlined with the wrapper dropped, silently
  compiling the route down to authenticated-only. Guards arguments that exist
  but cannot be folded are now marked `opaque` (`IGN_OPAQUE_GUARDS` warning),
  block handler inlining, and keep the runtime wrapper so the real guards run
  per request. Bare `withGuards(handler)` wrappers keep their previous
  static `requireAuthenticated` emission.
- **Compiler: a missing hook module now fails the build** (`IGN_HOOK_MISSING`
  and unreadable-hook `IGN_IO_READ_FAILED` became error-level). Previously a
  typo'd hook shipped a reference without an import — a per-request
  `ReferenceError` (500s) in production behind a build-time warning.
- **Compiler: context-usage analysis is conservative where it was unsound** —
  body-level destructuring off ctx (`const { body } = ctx`), defaulted
  destructured params (`({ query = {} }) => …`), rest-element params,
  root re-aliasing (`const b = ctx`) and assignment aliasing are now tracked;
  anything unenumerable degrades UP to full-context specialization instead of
  emitting a context missing members the handler reads (silent `undefined`).
- **SDK: FlatBuffers client arg binding matches the shared `.d.ts` ladder** —
  call shapes now cover all eight params/query/body combinations (query no
  longer lands in the body slot) and `ROUTE_ARGS` is keyed by `"method path"`
  so GET vs POST on one template can't collide.
- **SDK: recursive `$ref` schemas no longer crash generation** — cycle
  detection cuts the recursion point to `unknown` (tree-shaped components
  previously raised RangeError and aborted SDK output); non-recursive
  sibling refs stay precise.
- **SDK: `types.d.ts` always declares `Body_*` for body-reading routes** even
  when no OpenAPI body schema exists, so generated packages typecheck.
- **Debugbar: error traces record the real status** — `HTTPError.status`
  (422 validation, 401/403 auth, 404 …) is stored instead of a hardcoded 500,
  fixing status filters and AI summaries.
- **Cache invalidation: fingerprints are content-only and deterministic** —
  mtime no longer forces full rebuilds after `git checkout`/touch ("0 routes
  changed" yet full rebuild), and unsorted directory walks can't make the
  same tree hash differently across machines.

### Changed

- **Compiler artifacts are content-diffed** (`writeIfChanged`): identical
  rebuilds no longer rewrite `__server.js`, `manifest.json`, OpenAPI, types,
  validators or serializers — watcher/SDK-cache churn on every save is gone.
  `manifest.json` also dropped its wall-clock `generatedAt` in favor of a
  stable `version: 1` field, making it a pure function of build inputs.
- **Generated-code micro-allocations hoisted**: per-route cache options are
  frozen consts (no per-request options literal), the unmatched-OPTIONS
  wrapper is memoized once (was a fresh closure per request), serializer
  lookup drops its per-response `String(status)`, and route-graph module
  lookups use an index map instead of O(files × modules) scans.
- **Parse diagnostics carry real positions**: parser-chain failures surface
  the underlying oxc/parser message with byte offset → line/column code frame
  and the offending file (previously line 1 of an unnamed module).
- **Diagnostics DX**: `IGN_NO_HANDLER_EXPORT` remediation text shows real
  conventions (`export default get(...)` / `httpGet`), duplicate-route
  warnings name the surviving file, and empty route files warn
  (`IGN_EMPTY_ROUTE_FILE`) instead of vanishing silently.
- **Debugbar request detail includes a reproducible `curl`** (method + URL +
  redacted headers + captured body) served at `/api/requests/:id`, rendered by
  the dashboard's copy button; stray per-call `TextEncoder`s replaced with the
  shared singleton and UTF-8 length checks now use `Buffer.byteLength`.

### Added

- **Compiler regression suites**: usage-soundness tests pinning the
  conservative context-specialization behavior; opaque-guards fixture
  asserting guarded routes are never inlined away; `$ref` cycle SDK tests.

### Removed

- **`@ignex/nova` and `@ignex/ninox` are no longer workspace packages** —
  `packages/nova` and `packages/mongo` were removed from this monorepo. Both
  projects were synced back to their standalone repos first (strict-typing
  fixes, test gating, the ninox debugbar `traceDbOp` hook, generator
  `@ts-nocheck` emission — see the `sync:` commits in `ignex-nova` /
  `ignex-mongodb`), so no work was lost. ignus now consumes them as external
  packages: registry semver ranges in manifests, with local `file:` overrides
  (root `package.json` → `overrides`) pointing at the standalone repos for
  development. The `mongo`/`nova` CI jobs moved to the standalone repos' own
  workflows; the novaPlugin end-to-end bridge check (`verify:nova`) now runs
  against the external `@ignex/nova` via the `file:` link.

### Added

- **Debugbar: NATS event tracking (Events panel)** — a zero-dependency NATS
  core-protocol client (Bun TCP; INFO/CONNECT/PING/PONG/PUB/SUB/MSG, no npm
  package, JetStream-free) plus a bounded event ring buffer. Auto-enabled by
  `$NATS_URL` or `debugbar({ nats })`: subscribes to subjects (default
  `events.>`), records every outbound publish and inbound message with
  truncated payloads, and exposes `GET /api/events`,
  `POST /api/events/publish` (probe events) and `POST /api/events/clear`.
  Failures become error events; reconnect backs off — a broken server never
  crashes the app.
- **Debugbar: published-clients panel** — the Clients view probes
  `sdkPaths` + `clientPaths` (package.json / sdk.json / directories) and
  combines local package state with git tags (`git for-each-ref`, cached,
  `sdk-v*` prefix): name/version/location/files + **tagged ✓ vs local-only**.
  The KT page and `GET /api/sdks` now include the tag state.
- **Debugbar: AI debugging via MCP** — `@ignex/mcp` gained nine debugger
  tools (`debug-summary`, `debug-requests`, `debug-request`, `debug-replay`,
  `debug-events`, `debug-event-publish`, `debug-system`, `debug-clients`,
  `debug-kt`) driven by `IGNEX_DEBUGBAR_URL`/`IGNEX_DEBUGBAR_TOKEN`, plus a
  token-efficient `GET /api/ai/summary` snapshot (errors, slow traces, event
  stats, clients). The dashboard gained Events / Clients / AI views.
- **SDK: FlatBuffers frontend-client platform** — `ignex sdk --platform
  flatbuffers` emits an installable npm package: a real `schema.fbs` (wire
  envelope + route inventory), a typed per-route client sending
  `application/x-flatbuffers` envelopes on the official `flatbuffers` runtime
  (JSON fallback, GET/HEAD params in the URL), and `kind: "client"` metadata
  so the debugbar tracks it. Registered in `--platform all` for the CLI and
  `scripts/generate-sdk.ts`; publish/push/release flows are shared with the
  other SDK platforms.
- **Debugbar waterfall: automatic lifecycle-stage rows** — every request is
  now traced through the framework, not just the app's explicit `ctx.debug`
  spans: the `request`, `beforeHandle`, `handler`, `afterHandle`,
  `mapResponse`, `afterResponse` and `trace` stages each become waterfall
  rows (recorded in the interpreted pipeline, the router path and the
  compiler-generated server via shared `runTimed`/`debugStageEnd` runtime
  helpers). A request with zero manual instrumentation now shows exactly
  where its time went.
- **Debugbar time breakdown + idle gaps** — the Overview and Waterfall tabs
  show a per-kind breakdown (stacked bar + db/cache/http/render/auth/
  lifecycle/custom rows with ms and % of total, plus **unaccounted** time),
  and the waterfall draws hatched idle-gap segments between spans so
  event-loop waits are visible.
- **Debugbar expandable span rows** — clicking any waterfall bar unfolds the
  span's details (kind, start/duration, attrs such as query text or target
  URL, origin stack frame, error); the span tree shows attrs inline too.
- **Ninox DB ops in the debugbar** — every `@ignex/ninox` (Mongo) operation
  (CRUD, pagination, aggregation) is now recorded as a `db` span in the
  current request's trace when running inside ignex with the debugbar on
  (`traceDbOp` bridges into the ALS-propagated `debugQuery` helper via a
  lazy, cached optional import — zero dependency on `@ignex/core`, so
  standalone ORM usage and production apps pay nothing).
- **Bun-first scheduler** — `createScheduler` now ticks through `Bun.cron`
  (standard 5-field expressions + `@named` schedules, validated by
  `Bun.cron.parse` at registration, zero lockfile deps, built-in
  never-overlap). Legacy croner-style 6-field (second-precision) expressions
  keep working via an in-process matcher (`platform/cron6.ts`). `croner` was
  removed from the dependency tree.
- **Debugbar redesign** — tokenized dark/light themes, server-side KT
  rendering via `Bun.markdown` + an allowlist sanitizer (`debug/markdown.ts`),
  server-side request filters (`q`/`method`/`status`), request-detail tabs,
  gradient system charts, keyboard shortcuts, and a stylesheet served at
  `{path}/app.css`.
- **`@ignex/nova` as a workspace package** (`packages/nova`) — the typed
  FlatBuffer realtime transport (events/bindings/codegen layer, Rust FFI
  serializer, NATS bridge) is now source-published in-repo; `novaPlugin`'s
  runtime resolution is fixed (the tsconfig `paths` stub that shadowed the
  real package — breaking `import("@ignex/nova/server")` under Bun — is
  deleted) and `verify:nova` passes end-to-end.
- **`@ignex/ninox` as a workspace package** (`packages/mongo`) — the
  schema-first MongoDB toolkit (schema DSL → `$jsonSchema`, CRUD/pagination/
  aggregation, DataLoader relations, query cache, migrations) is now
  source-only in-repo and type-checks under the root strict flags.
- **CLI display-width helpers** — `utils/terminal.ts` (`Bun.stringWidth` /
  `Bun.sliceAnsi`-backed padding/truncation) used by `route:list` tables.
- **`verify:all`** root script (verify + mongo/nova gates) and
  **`test:parallel`** / **`verify:quick`** via `bun run --parallel`.
- **CI jobs** for the nova realtime transport (Rust addon build + suite +
  plugin bridge) and the Mongo toolkit (Mongo 7 service + suite + API check).
- Root `CHANGELOG.md` (this file).

### Changed

- `createScheduler`'s tick core is extracted into a shared, testable path;
  `ScheduledJob.stop()`/`running` semantics unchanged.
- Debugbar dashboard split into shell / stylesheet / app modules
  (`debug/dashboard-*.ts`).
- The lifecycle pipeline (interpreted, router and compiled) wraps every stage
  in shared `runTimed`/`debugStageEnd` instrumentation; the flat no-trace hot
  path is unchanged.
- `compiledPathFor` memoizes path→regex compilation on the interpreted
  router's hot path (route paths are a finite registration-time set).
- `docs/bun-internals.md` gained Bun 1.4 rows (Bun.cron, Bun.markdown,
  Bun.stringWidth family, `bun run --parallel`, `Bun.serve` static routes
  decision); `docs/native-acceleration.md` gained the 2026-08-22 wiring
  decisions; `docs/debugbar.md` gained a UI tour.

### Removed

- `croner` dependency (root + `@ignex/core`).
- `packages/core/src/vendor/nova.d.ts` ambient stub + its tsconfig `paths`
  entries.
- `@ignex/nova` / `@ignex/ninox` registry/`file:` deps (now `workspace:*`).

### Fixed

- Debugbar waterfall no longer shows a bogus "✕ … span left open" on the
  root span of every request (the root is the request itself), and framework
  stage rows are closed without the leak flag when the debugbar finalizes the
  trace inside the afterHandle stage.
- Debugbar dashboard `{path}/app.js` is served with `text/javascript` (was
  `text/html`), so browsers with strict MIME checking no longer refuse to
  execute it ("Refused to execute script … MIME type ('text/html')") — in
  both the AOT `onRequest` path and the interpreted router path. The shell
  also ships an inline favicon, removing the `/favicon.ico` 404.

### Fixed

- **Dashboard History view crashed with `v is not defined`** (`@ignex/core`
  debugbar): clicking the History tab threw a `ReferenceError` inside its
  fetch handler and rendered the misleading "v is not defined — Is the
  debugbar enabled and the server running?" panel (every app embedding the
  dashboard, including fresh scaffoldings). The renderer never declared its
  view element. Guarded permanently by a new EXECUTION test
  (`debugbar-dashboard-runtime.test.ts`): the served bundle runs against a
  stub DOM, every view + row-click/log-detail/trace-link path is driven, and
  any rendered ReferenceError/"is not defined"/"is not a function" panel
  fails CI — syntax-only checks cannot catch this bug class.

## [0.1.7] — 2026-08

Initial open-source milestone: AOT compiler pipeline with persistent parse
caching, Bun-native router codegen, precompiled Ajv validators + serializers,
native acceleration (`@ignex/native` × castrum), CLI, MCP server, durable
jobs, scheduler (croner), debugbar, and the example app. See the git history
for the full breakdown.
