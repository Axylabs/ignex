# Comparison benchmark: Bun vs Elysia vs Ignus

End-to-end HTTP comparison between three servers doing **the same amount of
work**, ported from the `bun-rust-runtime-bench` (castrum) project's benchmark
so the methodology and route contract match that project's.

```
┌─────────────────────────────────────────────────────────────────────┐
│  Shared contract (bench/compare/shared.ts)                          │
│    GET  /health        GET  /api/users    POST/PUT/PATCH /api/users │
│    POST /api/echo      GET  /api/cookies  OPTIONS preflight  · 404  │
└─────────────────────────────────────────────────────────────────────┘
        │                     │                     │
        ▼                     ▼                     ▼
  bun-server.ts         elysia-server.ts      ignus-server.ts
  (raw Bun.serve)       (Elysia + TypeBox)    (createApp + plugins)
        └─────────────────────┬──────────────────────┘
                              ▼
              weighted-flow loader (bench/compare/load.ts)
              → per-server reports in bench/results/compare/<server>/
```

## What each server does

All three implement an identical route contract over `bench/compare/shared.ts`:

| Route | Work performed |
|---|---|
| `GET /health` | request-id, (disabled) rate-limit check, security headers, CORS, `{ ok: true, requestId, path, query, cookies }` |
| `GET /api/users` | parse query string + cookies, echo both back |
| `POST/PUT/PATCH /api/users` | content-type guard (415) → JSON parse (400) → schema validation (422) → echo `{ query, cookies, body }` |
| `POST /api/echo` | stream the raw body back verbatim — no parse, no buffering |
| `GET /api/cookies` | parse cookies, echo back |
| `OPTIONS /api/users` | CORS preflight (204) |
| anything else | 404 `{ ok: false, error }` |

Every 2xx response must satisfy the wire contract `ok === true` **and**
`requestId` is a string — the loader validates this on every request (disable
with `HTTP_NO_SHAPE=1` for pure-throughput runs).

- **`bench/compare/servers/bun-server.ts`** — raw `Bun.serve` with its native
  `routes` router, Bun primitives (`req.json()`, `req.cookies`,
  `crypto.randomUUID()`), manual schema check.
- **`bench/compare/servers/elysia-server.ts`** — Elysia with `@elysia/cors`,
  `onAfterHandle` security headers, and TypeBox body schema (automatic 422).
- **`bench/compare/servers/ignus-server.ts`** — ignex `createApp` from
  `@ignex/core` with the `cors` and `security` plugins; the native addon is
  pre-warmed by `app.init()`.
- **`bench/compare/servers/ignus-aot-server.ts`** — the same route contract
  AOT-compiled through `@ignex/compiler` (`ignus-aot-app/`): Bun-native
  `routes`, guarded lifecycle, and the compiled reply path (`ctx.json` → one
  `TextEncoder` pass + exact `content-length`). This is the framework's
  flagship path and is part of the **default** run alongside bun/elysia/ignus.

## Running

```bash
bun install                       # first time (adds elysia + @elysia/cors)
bun run bench:compare:verify      # quick contract check on all three servers
bun run bench:compare:smoke       # 01-smoke (wire/shape guard)
bun run bench:compare:crud        # 16-crud-validation-mix
bun run bench:compare:heavy       # 13/14/15 heavy-JSON validation
bun run bench:compare:stress      # 03-stress
bun run bench:compare:soak        # 05-soak + 18-json-validation-soak (long)
bun run bench:compare             # all non-soak scenarios, all servers
bun run bench:compare:check       # gate: 0 unexpected failures, cross-server parity
```

The orchestrator (`bench/compare/run-bench.ts`) boots each server on its own
port (bun 9120, elysia 9121, ignus 9122), asserts the port is free, waits for
`/health`, and warns (or fails with `IGNEX_BENCH_REQUIRE_NATIVE=1`) if the ignus
native addon is not active.

### Env controls

| Env | Effect |
|---|---|
| `SCENARIO=<substr>` | only run scenarios whose name includes `<substr>` (also `argv[2]`) |
| `SERVER=<kind>` | only run one participant: `bun` / `elysia` / `ignus` / `ignus-aot` (also `argv[3]`) |
| `INCLUDE_SOAK=1` | include the long soak scenarios in a default run |
| `DURATION_SCALE=n` | multiply every phase duration (e.g. `0.2` for a quick pass) |
| `HTTP_NO_SHAPE=1` | skip response-shape validation (pure throughput) |

## Results

Per server, under `bench/results/compare/<server>/`:

```
01-smoke.bench.json        # machine-readable (see schema below)
01-smoke.bench.md          # human-readable report
01-smoke.bench.html        # browsable report
01-smoke.failures.ndjson   # one JSON line per unexpected failure
```

Each report records per-request latency percentiles (avg/min/p50/p75/p90/p95/
p99/p999/max), per-route counts + error %, achieved RPS, and grouped failures.
`bun run bench:compare:check` asserts zero unexpected failures per report and
that every server produced the same scenario set.

## Methodology notes (ported from the rust project)

- **Weighted flows + rate-paced phases.** Each scenario defines phases at a
  target rps (`0` = idle, omitted = fire as fast as possible) and flows chosen
  by weight; a concurrency gate caps in-flight VUs.
- **Response-shape validation.** Every 2xx is `JSON.parse`d and must have
  `ok: true` + `requestId: string` — the wire format is a contract.
- **Rate limiter wired but disabled** (`limit = UINT32_MAX`) so the pipeline
  work is identical on every server without throttling throughput.
- **Known framework asymmetries** are encoded as accepted alternate statuses
  with inline comments, so the comparison stays fair and the gate stays green:
  - Elysia returns **422** (not 415) for a non-JSON body on a typed route.
  - Elysia does **not** reject `additionalProperties` — it returns **200**
    where raw Bun/ignex return **422** for unknown fields.
  - Elysia returns **422** (not 400) for an empty body on a typed route.
  - Heavy-JSON payloads are schema-valid (the rust project's original complex
    payloads with extra fields fail on its strict bun/ingress servers — see
    its `13-heavy-json-nested` failure traces).

## Scope

The comparison bench is self-contained under `bench/compare/`; it does not
touch the existing `bench:server` (AOT-compiled app vs raw Bun) benchmark. In
addition to the interpreted `ignus` participant, the AOT-compiled participant
(`ignus-aot`) is now part of the **default** run — it exercises the same route
contract through `@ignex/compiler`, and a `SERVER=ignus-aot` filter runs it
alone. The interpreted `createApp` path is additionally covered by the
`bench:server` benchmark and the core test suite.
