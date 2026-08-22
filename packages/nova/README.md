# ignex-nova

TypeBox-driven **FlatBuffer transport over Bun WebSockets** with a Rust FFI
serializer — and a typed pub/sub API that hides all of it from developers.

```ts
// server (Bun)
import { createServer } from "ignex-nova/server";
const server = createServer({ port: 3000, inbound: ["chat"] });
server.publish("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2, bidSize: 100, askSize: 200, ts: Date.now() });
server.publishToTopic("equities", "quote", {...});   // rooms
server.on("chat", (msg, ws) => server.publishTo(ws, "chatAck", { ok: true }));

// FE (browser or Bun)
import { createClient } from "ignex-nova/client";
const client = createClient("ws://localhost:3000/ws", { reconnect: true });
client.on("quote", (q) => console.log(q.symbol, q.bid)); // q is a plain typed object
client.subscribe("equities");       // rooms + last-value replay
client.send("chat", { text: "hi" }); // typed client→server (pure-JS encoder — works in the browser)
client.connect();
```

No `flatbuffers.Builder`, no `getRootAs*`, no FFI — developers only ever see
plain, type-checked objects. The FlatBuffer + Rust machinery is internal, and
the **browser can send typed frames too** (via a generated pure-JS encoder).

## Bring your own schema (generic bindings)

The transport is **schema-driven**: the built-in events (quote/trade/…) are
just the default registry. Define **any** TypeBox schema in your app and
`generateBindings(schema)` produces a complete, typed wire stack for it —
same APIs, same NATS story, your events:

```ts
// scripts/generate-bindings.ts
import { generateBindings } from "ignex-nova/generate";
import { schemas, events, controlEvents } from "../src/schema"; // YOUR TypeBox
generateBindings({ schemas, events, controlEvents }, { outDir: "./ignex/generated" }).write();

// bindings.ts
import { makeBindings } from "./ignex/generated";
import * as schema from "../src/schema";
export const bindings = makeBindings(schema);

// server.ts — publish/on typed against YOUR events; NATS bridging included
const server = createServer({ port: 3000, bindings, inbound: ["chat"],
  nats: { servers: ["nats://localhost:4222"], inbound: true, bridgeClientEvents: true } });
server.publish("chat", { room: "lobby", text: "hi", ts: Date.now() });
```

The generated stack (flatc TS decoders + pure-JS encoder + direct fast-path
serde + `wire-registry.json` for NATS consumers + an optional Rust crate for
the FFI fast path) works without a Rust toolchain — the server falls back to
the pure-JS encoder when no addon is present. Full guide:
[docs/generic-bindings.md](docs/generic-bindings.md).

## Features

- **Typed pub/sub, both directions** — `publish`/`publishTo`/`publishToTopic`
  on the server, `on`/`send`/`subscribe` on the client. Control frames
  (hello/subscribe/ping/…) ride the same codegen, routed internally.
- **Rooms / topics** with optional **last-value replay** on subscribe
  (`replay: { historySize }`).
- **Backpressure** — configurable slow-consumer policy (drop-oldest /
  drop-newest / disconnect) so a hot publish loop can't balloon memory.
- **Auth & limits** — async `authenticate(req)` hook, origin allowlist, bearer
  `token`, `maxConnections`, `maxMessageSize`, TLS passthrough.
- **Resiliency** — auto-reconnect with exponential backoff + jitter,
  auto-resubscribe, app-level heartbeat.
- **Exact int64** — `Type.BigInt()` fields round-trip losslessly beyond 2^53;
  optional `int64Guard` catches out-of-range numbers.
- **Observability** — `server.getMetrics()` (counters + per-event encode path),
  JSON `/health`, graceful `drain()`.
- **Targeted delivery & groups** — every client has a stable id (from
  `authenticate` metadata or an auto-UUID) so you can `publishToClient(id, …)`;
  server-side groups (`publishToGroup(group, …)`, joined via auth metadata,
  `joinGroup(id, group)`, or client `joinGroup` frames) target sets of clients.
  Active clients are listed via `getClients()` / `GET /clients`.
- **Generic, schema-driven** — `generateBindings(schema)` (from
  `ignex-nova/generate`) builds the whole wire stack for ANY TypeBox schema in
  your app; `createServer` / `createClient` / `createNatsBridge` accept the
  resulting `bindings` and are fully typed against your events. The built-in
  events are just the default registry.
- **NATS bridge (bidirectional)** — every broadcast/topic/group publish is also
  published to NATS as the **same FlatBuffer wire frame** (`ignex.broadcast.*`,
  `ignex.topic.*`, `ignex.group.*`) so other applications can consume it;
  external apps push events into the hub via `ignex.inbound.>` and the server
  forwards them to clients. `bridgeClientEvents: true` re-publishes client-sent
  events to the cluster (horizontal scaling). Best-effort (never blocks the WS
  hot path), observable via metrics.
- **Events layer** (`ignex-nova/events`, opt-in via `createServer({ events })`)
  — the application-facing event-driven system on top of the transport: an
  **events file** receives events (`server.events.on(...)` with a context
  carrying the sender's client record), a **global emit** sends events through
  websockets from anywhere (`emit` / `emitToGroup` / `emitToUser` /
  `emitToClient`), **client records** model "who is connected, on whose behalf
  (`userId`), and what to remember per connection (`client.data`)", **client
  groups vs user groups** make group-vs-user targeting explicit, and an
  optional **cluster sync** (NATS and/or Redis, offloaded from hot paths)
  delivers every emit to the target's clients across horizontally scaled
  instances, with presence + shared-state indexes. See
  [docs/events.md](docs/events.md).
- **Bun-only server, browser+Bun client.** Wire spec documented for independent
  clients: [docs/wire-format.md](docs/wire-format.md).

## How it works

```
src/schema/index.ts (TypeBox — source of truth: app events + control events)
        │  scripts/generate.ts
        ▼
backend.fbs ──flatc --ts──▶ src/generated/ts/          (decoders)
        └───flatc --rust──▶ rust/src/generated/         (table builders)
scripts/rust-glue-gen.ts ─▶ rust/src/transcode/         (JSON glue + direct-args FFI)
scripts/direct-gen.ts ────▶ src/generated/direct-ser.ts (direct fast-path serde)
scripts/ts-ser-gen.ts ─────▶ src/generated/ts-ser.ts    (pure-JS browser encoder)
scripts/registry-gen.ts ───▶ src/generated/registry.ts  (event routing, both sides)

server:  JS object ─▶ (flat event) fields as direct FFI args ─▶ Rust
                   └▶ (vector/nested) JSON.stringify → cstring ─▶ Rust
browser: JS object ─▶ flatc object API (ts-ser) ─▶ size-prefixed FlatBuffer
Rust + ts-ser both emit the same frame:
  frame = [WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]
Bun: ws.send(frame) ──▶ peer: decode via generated classes → plain object
```

**Two server serialize paths** (neither uses JSON on the hot path):

- **Direct fast path (zero-allocation)** — directable events: fields pushed
  straight into generated `extern "C"` functions as FFI args, output written
  into a single reusable scratch. Measured ~0 B/op.
- **JSON fallback** — only for nested tables-in-tables / unions (e.g. `order`),
  or payloads with embedded NULs. Observable via `getMetrics().pathCounts`.

The **browser client** has no FFI, so outgoing frames (app + control) use the
generated pure-JS encoder (flatc object API over a pooled builder).

Key techniques (Bun 1.4 standard practices, following the castrum FFI guide):

- strings as pre-encoded `(buffer, usize)` via `Buffer.write` into a cached view
  (zero JS-side text encoding, zero allocation); vectors as packed binary blobs
- `buffer` / `buffer_length` ABI pair for the output — the engine snapshots
  pointer + byteLength off the same view at call time (the "peak"/pointer +
  length pattern). `returns: 'u64_fast'` for byte counts.
- `ws.send(Uint8Array)` copies synchronously (verified) → the shared output
  scratch is safe to reuse immediately.
- Rust `#[no_mangle] extern "C"` exports, `panic_guard`-wrapped, needed-size
  convention, `thread_local` reused `FlatBufferBuilder` + `reset()` per call.
- Bind-time self-test: `fb_probe` magic + `fb_wire_version` (stale-cdylib
  guard) + a per-symbol direct self-test that DISABLES broken symbols
  (graceful JSON fallback instead of a hard crash).
- Stable event ids = FNV-1a 32-bit over the name (reorder-safe, collision-
  checked at generate time).
- `flatc` guarantees wire compatibility between the Rust builders and the
  browser decoders (both derive from the same `.fbs`).

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.4
- Rust toolchain (`cargo`)
- `flatc` (FlatBuffers compiler): `brew install flatbuffers`,
  `apt install flatbuffers-compiler`, or from <https://flatbuffers.dev>.
  Keep `flatc` and the `flatbuffers` crate/npm versions aligned.

## Setup

```bash
bun install            # deps: @sinclair/typebox, flatbuffers
bun run generate       # TypeBox → .fbs → flatc --ts/--rust → Rust glue + registry
cargo build --release --manifest-path rust/Cargo.toml   # → <platform> libignex_ffi (.so/.dylib/.dll)
bun run build:client   # bundle the browser demo → client-dist/
bun test               # round-trip + FFI tests (needs generate + built addon)
bun run lint           # oxlint — FP-discipline rules (no-var, no-param-reassign, …)
bun run serve          # demo: http://localhost:3000/  (ws: /ws)
```

`bun run build` runs generate + build:rust + build:client together.
`bun run build:dist` emits an npm-ready JS bundle + declarations to `dist/`.

**Perf gate:** `bench/BASELINE.md` records the reference numbers. After any
hot-path change run `bun run bench:serialize` + `bun run bench:throughput` and
compare — fail-fast on >±5% drift in encode latency/throughput or any new
allocations on the `quote` path (must stay ~0 B/op).

## Install & use from npm

Published as **TypeScript source** (no build step needed — Bun runs `.ts`
natively), with subpath entrypoints. Works in any Bun ≥ 1.4 project:

```bash
bun add ignex-nova
```

```ts
// server (Bun-only — needs the native addon, see below)
import { createServer } from "ignex-nova/server";

// client (browser + Bun) — the root entry also re-exports everything
import { createClient, type Events } from "ignex-nova/client";

const q: Events["quote"] = { symbol: "AAPL", bid: 180.1, ask: 180.2, bidSize: 100, askSize: 200, ts: Date.now() };
```

Entrypoints:

| Import | Resolves to |
| --- | --- |
| `ignex-nova` | `index.ts` — everything (server + client + nats + schema types + generic codegen) |
| `ignex-nova/server` | `public/server.ts` — `createServer` (Bun-only) |
| `ignex-nova/client` | `public/client.ts` — `createClient` (browser + Bun) |
| `ignex-nova/nats` | `public/nats.ts` — standalone `createNatsBridge` |
| `ignex-nova/generate` | `public/generate.ts` — `generateBindings` (ANY-schema codegen) |
| `ignex-nova/bindings` | `public/bindings.ts` — `assembleBindings` / `defaultBindings` + types |
| `ignex-nova/internal` | `public/internal.ts` — runtime helpers used by generated code |

**Native addon:** the tarball ships `rust/` source + `prebuilds/<platform>-<arch>/`
for the platforms built at release (see CI). If your platform has a prebuild it
just works. Otherwise either rebuild from the shipped source:

```bash
cargo build --release --manifest-path node_modules/ignex-nova/rust/Cargo.toml
# loader finds it at <pkg>/rust/target/release/…
# or point at any build explicitly:
IGNEX_FFI_PATH=/abs/path/to/libignex_ffi.so bun run your-server.ts
```

See [docs/publishing.md](docs/publishing.md) for how the package is built,
staged, and published to npm.

## Layout

| Path | Role |
| --- | --- |
| `src/schema/index.ts` | built-in TypeBox schemas + `events`/`controlEvents` registries (source of truth for the DEFAULT registry) |
| `src/bindings/` | the generic `Bindings` contract: `types.ts` (runtime wire-stack interface + `EventNameOf`/`EventsOf`), `assemble.ts`, `default.ts` (built-in bindings) |
| `src/codegen/` | the schema→wire emitters (published — `ignex-nova/generate` uses them at runtime) |
| `scripts/` | dev tooling: `generate.ts` orchestrator, prebuild/pack/release helpers (not published) |
| `src/generated/` | flatc `--ts`/`--rust` output + `registry.ts` + `direct-ser.ts` + `ts-ser.ts` (built-in schema) |
| `rust/` | cdylib: `ffi.rs` (C-ABI), `transcode/generated.rs` (glue) |
| `src/native/` | `bun:ffi` binding, self-tests, per-platform addon loader |
| `src/transport/` | `transport.ts` (`encodeToScratch`), `scratch.ts` (reusable zero-alloc buffer), `stats.ts` |
| `src/core/` | functional modules: `server.ts`/`client.ts` composition roots, `state.ts`, `auth.ts`, `rooms.ts`, `groups.ts`, `replay.ts`, `backpressure.ts`, `outbound.ts`, `routing.ts`, `metrics.ts`, `int64-guard.ts`, client-* |
| `src/bridge/` | optional NATS bridge: `nats.ts` (injectable transport, eager non-blocking connect), `subjects.ts` (subject naming) |
| `public/server.ts` | entrypoint shim: `createServer` (publish/rooms/groups/targeting/NATS/auth/backpressure/metrics/drain) |
| `public/client.ts` | entrypoint shim: `createClient` (on/send/subscribe/joinGroup/reconnect/heartbeat/status) |
| `public/nats.ts` | entrypoint shim: `createNatsBridge` standalone (`ignex-nova/nats`) |
| `client/` | browser demo (built to `client-dist/`) |
| `bench/` | serialize latency + end-to-end throughput (+ `BASELINE.md` perf gate) |
| `examples/` | `nats-consumer.ts` — independent NATS consumer for bridged frames |
| `prebuilds/` | staged native addons per platform (`<platform>-<arch>/`), built by `bun run prebuild` / CI |
| `docs/` | `wire-format.md`, `architecture.md`, `publishing.md` |

## Adding an event

**Built-in registry:** 1. Define the payload in `schema/index.ts` (TypeBox), add
it to `schemas` (if it's a named table) and to `events` (name → schema). For
exact integer values use `Type.BigInt()`. 2. Re-run `bun run generate`,
`cargo build --release`, `bun run build:client`. 3.
`server.publish("yourEvent", payload)`, `client.on("yourEvent", cb)`, and
`client.send("yourEvent", payload)` are now fully typed on both sides.

**Your own registry:** you don't edit this repo at all — define the schema in
your app and run `generateBindings` (see
[docs/generic-bindings.md](docs/generic-bindings.md)).

## Performance (min-of-N ns/op on this machine, `bun run bench:serialize`)

| Payload | Rust FFI (zero-alloc) | Pure JS flatc | Rust vs JS |
| --- | --- | --- | --- |
| quote | **~190–270 ns** | ~500–740 ns | **~2–3× faster** |
| portfolio (3 positions) | **~0.9–1.0 µs** | ~1.6 µs | **~1.5× faster** |
| 200-position portfolio | **~26 µs** | ~64 µs | **~2.5× faster** |

Directable events serialize with **~0 B/op** (reusable scratch, no per-call
allocations, no JSON). End-to-end over a real WebSocket (`bench:throughput`):
**~1.18M msg/s**.

## Server options (all optional)

```ts
createServer({
  port: 3000,
  path: "/ws",                      // websocket path
  inbound: ["chat"],                // app events clients may SEND
  backpressure: { highWaterMark: 1 << 20, policy: "drop-oldest", maxQueue: 256 },
  replay: { historySize: 64 },      // per-topic last-value replay on subscribe
  authenticate: async (req) => checkToken(req.headers.get("authorization")),
  allowedOrigins: ["http://localhost:3000"],
  token: "shared-secret",           // or (tok) => boolean
  maxConnections: 10_000,
  maxMessageSize: 64 * 1024,
  int64Guard: "warn",               // "off" | "throw" | "warn"
  nats: { servers: ["nats://localhost:4222"], inbound: true }, // optional NATS bridge
  tls: { keyFile, certFile },       // enables wss://
});
```

## Client options (all optional)

```ts
createClient("ws://...", {
  reconnect: { initialDelay: 250, maxDelay: 30_000, jitter: true }, // or true/false
  heartbeatMs: 15_000, heartbeatMisses: 2,
});
```

## Targeted sends, groups & NATS

```ts
// identity: authenticate() can pin the id + seed groups + attach metadata
createServer({
  port: 3000,
  authenticate: async (req) => {
    const user = await whoIs(req);             // e.g. from a JWT
    return { id: user.id, groups: user.tier ? ["premium"] : [], meta: { name: user.name } };
  },
  nats: { servers: ["nats://localhost:4222"], inbound: true }, // optional bridge
});

// targeted sends / groups (server)
server.publishToClient("user-42", "quote", {...});   // one client by id (not bridged)
server.joinGroup("user-42", "eu");                   // server-side grouping
server.publishToGroup("eu", "quote", {...});         // → ignex.group.eu.quote on NATS
server.getClients();                                 // [{ id, groups, topics, meta, connectedAt, ip }]

// clients can also join groups + learn their assigned id
client.joinGroup("beta");
client.leaveGroup("beta");
client.onStatus(() => console.log("my id:", client.clientId));
```

NATS consumers (any language) decode bridged frames from
`src/generated/fbs/backend.fbs` + the FNV-1a id map in `src/generated/wire-registry.json`
— see [docs/wire-format.md](docs/wire-format.md) and `examples/nats-consumer.ts`.
For your OWN schema, `generateBindings` emits the same `backend.fbs` +
`wire-registry.json` into your project — see
[docs/generic-bindings.md](docs/generic-bindings.md).

## Events layer (the event-driven system)

```ts
import { createServer } from "ignex-nova/server";
import { on, emit, emitToUser } from "ignex-nova/events"; // global singleton

const server = createServer({
  port: 3000,
  events: {
    onConnect: (client) => client.data.set("since", client.connectedAt),
    cluster: { nats: true },           // optional: cross-instance sync
  },
});

// the events file — receive events (ctx carries the sender's client record)
on("chat.message", (payload, ctx) => {
  emitToUser(payload.to, "chat.delivered", { id: payload.id });
});

// the global emit — send events through websockets from anywhere
emit("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2 });          // broadcast
emitToUser("u-42", "order.update", { orderId: "o-1" });             // a user's sockets
emit("alert", { text: "halt" }, { type: "group", group: "traders" }); // to a group

// client records: id / userId (on whose behalf) / data / groups
server.events.client("c-1")?.data.set("tier", "gold");
server.events.clientsByUser("u-42");   // every device of u-42
server.events.userGroup("ops").add("u-42").emit("pager", { text: "…" });
```

Full API, cluster semantics, presence, shared-state (Redis) indexes and
performance notes: **[docs/events.md](docs/events.md)**. The events layer is
opt-in — without `events`, there is zero overhead.

## Publishing to npm

Publish directly from source — `bun publish` runs the release gate
(`generate` → typecheck → lint → test) and `prepack` stages the native addon:

```bash
bun run release:dry    # plan only — print what would happen
bun run release        # patch bump → verify → publish → commit/tag/push
bun run release minor  # minor bump
bun run release --version 0.2.0   # explicit version
```

CI (`.github/workflows/publish.yml`) builds `prebuilds/` for
ubuntu/macos/macos-13, merges them, verifies, and publishes on a `v*` tag or
`workflow_dispatch` with `NPM_TOKEN`. Full details: [docs/publishing.md](docs/publishing.md).

## Notes / limits

- The direct fast path covers flat types AND vectors of flat tables (packed
  bridge). Events with nested tables-in-tables or unions fall back to JSON —
  the path is observable via `server.getMetrics().pathCounts`.
- Plain `number` int64 fields lose precision above ±2^53-1 — use `Type.BigInt()`
  for exact fields, or enable `int64Guard`.
- The output buffer is a single reusable scratch — the returned view is only
  valid until the next `publish`; `publish` sends immediately (Bun copies), so
  this is safe.
- Event ids are stable FNV-1a hashes (not insertion order) — regenerate all
  artifacts together.
- The server is **Bun-only** (`bun:ffi`, `Bun.serve`); the client runs in
  browser + Bun. Node server support is out of scope.
- Full gap-based replay (per-frame sequence numbers) is a documented future
  extension; today the server replays bounded per-topic history on subscribe.
- Docs: [wire-format.md](docs/wire-format.md) (incl. building an independent
  client), [architecture.md](docs/architecture.md). MIT licensed, CI on
  ubuntu + macos.
