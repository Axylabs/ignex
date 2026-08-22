# Architecture

ignex-nova is a TypeBox-driven **FlatBuffer transport over Bun WebSockets** with
a Rust FFI serializer — hidden behind a typed pub/sub API.

## Pipeline

The wire stack is generated from TypeBox schemas. The built-in registry
(`src/schema/index.ts`) runs the in-repo orchestrator (`scripts/generate.ts`);
**any** app can run the same emitters on its own schema via
`generateBindings` (`ignex-nova/generate` → `src/codegen/`).

```
src/schema/index.ts (TypeBox — single source of truth: app events + control events)
        │  scripts/generate.ts   (or generateBindings() for YOUR schema)
        ▼
backend.fbs ──flatc --ts──▶ src/generated/ts/          (decoders, both sides)
        └───flatc --rust──▶ rust/src/generated/         (table builders)
src/codegen/rust-glue-gen.ts ─▶ rust/src/transcode/     (JSON glue + direct-args FFI)
src/codegen/direct-gen.ts ────▶ src/generated/direct-ser.ts (zero-alloc server encoder)
src/codegen/ts-ser-gen.ts ─────▶ src/generated/ts-ser.ts    (pure-JS browser encoder)
src/codegen/registry-gen.ts ───▶ src/generated/registry.ts  (event routing, both sides)
scripts/generate.ts ───────────▶ src/generated/wire-registry.json (name→id map for external consumers)
```

Every artifact is also emitted per-user-schema by `generateBindings`
(`src/codegen/*` emitters, `public/generate.ts`) into the app's
`ignex/generated/` folder, then assembled into a runtime `Bindings`
(`src/bindings/`) that `createServer` / `createClient` / `createNatsBridge`
accept via `options.bindings` (default: the built-in `defaultBindings`). See
[docs/generic-bindings.md](generic-bindings.md).

## Functional composition

The public API is built by **functional composition over an explicit state
object** — no classes, no `this`. `public/server.ts` and `public/client.ts`
are thin re-export shims that keep the npm entrypoints (`ignex-nova/server`,
`ignex-nova/client`) and the `dist` build stable; the implementation lives in
`src/core/`.

- **Composition roots** (`src/core/server.ts`, `src/core/client.ts`) — the only
  places that know how the pieces fit together. `createServer(options)` builds
  the `ServerState`, wires `Bun.serve`, and returns a plain API object;
  `createClient(url, opts)` builds the client state and returns a plain API
  object with closures over it.
- **Action modules** are pure-ish functions `(state, ...) => ...` that read/
  mutate the explicit state: `auth` (upgrade gate), `rooms` (membership +
  fan-out), `replay` (per-topic history), `backpressure` (pure `decide` → send/
  enqueue/drop/close), `outbound` (the only place that touches `ws.send` and
  the per-socket queue), `routing` (inbound dispatch), and the client's
  `client-wire` / `client-reconnect` (pure backoff math) / `client-heartbeat`.
- **Factories** for encapsulated mutable state: `createMetrics()`, `createScratch()`
  (reusable zero-alloc output buffer), `createStats()` (encode-path counters).
  `int64-guard` intentionally stays a module-global (cheap `off`-mode no-op) so
  threading it through the generated encoders can't cost the ~200ns hot path.
- **Dev discipline**: `bun run lint` (oxlint with FP rules: no-var,
  prefer-const, no-param-reassign `props:false`, prefer-arrow-callback,
  no-else-return, consistent-return, no-nested-ternary, no-loop-func, …) runs
  in CI after `tsc`. Perf is gated by `bench/BASELINE.md` — re-run
  `bench:serialize` + `bench:throughput` before/after hot-path changes and
  fail-fast on >±5% drift or new allocations.

## Encode paths (server)

- **Direct fast path (zero-alloc)** — directable events (flat types + packed
  vectors) are pushed straight into Rust FFI args from a reusable scratch; the
  output is written into a single reusable buffer. ~0 B/op.
- **JSON fallback** — nested tables/unions (e.g. `order`) serialize through
  `JSON.stringify → fb_serialize → serde_json`. Slower + allocating; the
  per-event encode path is observable via `server.getMetrics().pathCounts`.
- A payload containing an embedded NUL is routed to the JSON path (the
  `cstring` direct path would silently truncate it).

## Encode path (client / browser)

Browsers have no Rust FFI, so outgoing frames (app events **and** control
frames) are encoded by `generated/ts-ser.ts` — flatc's object API (`XxxT` +
`pack`) over a pooled `flatbuffers.Builder`. No JSON.

## Runtime layout

- `public/server.ts`, `public/client.ts`, `public/nats.ts` — thin re-export shims
  (npm entrypoints `ignex-nova/server` / `client` / `nats` + the `dist` build).
  Implementation is in `src/core/` + `src/bridge/`.
- `src/core/server.ts` — `createServer` composition root: `Bun.serve`, client
  registry (id → socket), rooms, groups, inbound routing, control frames,
  auth/origin/token gates, backpressure, replay history, metrics, NATS bridge
  hook, graceful drain, `/health` + `/clients`.
- `src/core/client.ts` — `createClient` composition root: typed
  `on`/`send`/`subscribe`/`joinGroup`, reconnect with backoff, heartbeat, status
  events, `clientId`/`groups` (from the `welcome` control frame).
- `src/core/{state,auth,rooms,groups,replay,backpressure,outbound,routing}.ts` —
  server action modules over the explicit `ServerState`. `groups.ts` mirrors
  `rooms.ts` (targeting sets, no replay); `state.clients` is the id→socket
  registry, `state.groups` the group→members index.
- `src/core/{client-state,client-wire,client-reconnect,client-heartbeat}.ts` —
  client action modules over the explicit client state.
- `src/bridge/{nats,subjects}.ts` — optional NATS bridge: `createNatsBridge`
  (injectable `NatsTransport` for tests; eager non-blocking connect with retry),
  subject builders (`ignex.broadcast.*` / `ignex.topic.*` / `ignex.group.*` /
  inbound `ignex.inbound.>`). Outbound frames are copied from the shared
  scratch; inbound frames are decoded via `readFrameHeader`/`decodePayload` and
  forwarded to clients (never re-bridged). `subscribeRaw` exposes raw byte
  subscriptions (re-subscribed on reconnect) for the events cluster layer.
- `src/core/metrics.ts`, `src/core/int64-guard.ts` — `createMetrics()` factory
  + the exact-int64 safety net.
- `src/events/*` — the events layer (opt-in via `createServer({ events })`,
  public entry `ignex-nova/events` → `public/events.ts`): `hub.ts` composition
  root (`server.events`, binds the module-global `emit`/`on` singleton),
  `types.ts` (`EventClient` records with `userId` + per-connection `data`,
  `EmitTarget` discriminated union, hub/options interfaces), `registry.ts`
  (multi-handler dispatch with isolation), `clients.ts`/`data.ts` (client
  store: byId + byUser index), `groups.ts` (client groups reusing the
  transport registry + user groups), `emit.ts` (encode-once local fan-out +
  bridge + cluster), `cluster.ts` (origin-tagged envelope, NATS/Redis/custom
  transports, presence, shared-state indexes), `queue.ts` (bounded offload
  workers that keep all cluster/state work off the WS hot path), `global.ts`
  (the importable `emit`/`emitToGroup`/… singleton).
- `src/transport/{transport,scratch,stats}.ts` — object → frame encoding:
  `encodeToScratch` (direct/JSON), the reusable zero-alloc scratch, and
  encode-path stats.
- `src/generated/` — flatc `--ts`/`--rust` output + `registry.ts` +
  `direct-ser.ts` + `ts-ser.ts` + `wire-registry.json` (emitted; regenerated by
  `bun run generate`).
- `src/schema/index.ts` — TypeBox source of truth.
- `src/native/*` — the only place that talks to Rust: `dlopen` binding with a
  bind-time self-test (a failing direct symbol is disabled → JSON fallback),
  `buffer`/`buffer_length` ABI probing, per-platform addon resolution.
- `rust/` — a cdylib exporting `#[no_mangle] extern "C"` symbols, `panic_guard`-
  wrapped, `thread_local` reused `FlatBufferBuilder`.

## Client identity, targeting & the NATS bridge

- **Identity**: `authenticate(req)` may return `{ id, groups, meta }`; otherwise
  a UUID is assigned at upgrade (`auth.ts`). Ids are de-duplicated (409 at
  upgrade, stale-session kick at open). `state.clients: Map<id, socket>` is the
  live registry; the server sends the `welcome` control frame so each client
  knows its id + server-side groups.
- **Targeting**: `publishToClient(id, …)` (single socket, not bridged),
  `publishToGroup(group, …)` (server-side targeting sets — from auth metadata,
  `joinGroup(id, group)`, or client `joinGroup` control frames).
- **Bridge**: `createServer({ nats })` creates a `NatsBridge`. The fan-out path
  (`fanOutAll`) encodes once and reuses that frame for WS clients AND NATS
  (`frame.slice()` copy — the scratch is reused). Subjects are derived by
  `src/bridge/subjects.ts`. Inbound NATS events are decoded and forwarded via
  `fanOutAll` (no bridge call → loop prevention). All bridge counters fold into
  `server.getMetrics()`.

## Why it's fast

- Zero-alloc server encode (reusable scratch + Bun's synchronous `ws.send`
  copy).
- FlatBuffers = zero-parse reads, no JSON on the hot path.
- flatc guarantees the Rust builders and TS decoders agree byte-for-byte.

## Runtime & platform constraints

- **Server is Bun-only** (`bun:ffi`, `Bun.serve`). Node is not supported.
- The native addon is per-OS (`.so`/`.dylib`/`.dll`) — see
  `src/native/loader.ts`. Build it with `cargo build --release`.
- The **client** works in Bun AND browsers (bundle with
  `bun build --target=browser`).

## Known limits (documented, not hidden)

- Plain `number` int64 fields lose precision above ±2^53-1 — use
  `Type.BigInt()` fields for exact values, or enable `int64Guard`.
- The direct fast path covers flat types + packed vectors; nested single-object
  tables fall back to JSON (observable via metrics).
- Full gap-based replay (per-frame sequence numbers) is a future extension;
  today the server replays bounded per-topic history on subscribe.
