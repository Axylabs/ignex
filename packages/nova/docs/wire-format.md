# Wire format

This document pins the on-the-wire contract so anyone can build an independent
client from the generated FlatBuffers schema — no Bun, no Rust, no FFI needed.

## Frame

Every WebSocket **binary** frame is:

```
┌──────────┬───────────────────┬──────────────────────────────────┐
│ version  │ event_id          │ size-prefixed FlatBuffer         │
│ 1 byte   │ u32 (LE)          │ (flatc: 4-byte size prefix + buf)│
└──────────┴───────────────────┴──────────────────────────────────┘
    offset 0      1..5                 5..
```

- `version` = `WIRE_VERSION` (currently `1`). A peer MUST drop frames whose
  version it doesn't recognize (the decoders return `null`).
- `event_id` = **FNV-1a 32-bit hash of the event name** (e.g.
  `fnv1a32("quote")`). Stable across schema reordering; collisions are rejected
  at generate time. The id→name table is emitted in `src/generated/registry.ts`.
- The payload is a **size-prefixed FlatBuffer** (built by flatc, both Rust
  builders and the TS object API) with the root table for that event id.

There is **no per-frame checksum and no authentication** — the envelope id byte
is trusted. Integrity and AuthN are the application's job (see
[Security](#security)).

## Event ids

Event ids are stable hashes, so adding events, reordering the registry, or
adding fields does not renumber the wire format. Compute them with FNV-1a 32:

```
h = 2166136261
for each byte b of the UTF-8 event name:
    h ^= b
    h = (h * 16777619) mod 2^32
```

## Control frames

A fixed set of transport-internal events share the SAME frame format and the
SAME codegen, but are routed internally (never delivered to app handlers):

| name | direction | payload |
| --- | --- | --- |
| `hello` | both | `{ version, caps: string[], lastSeq }` — sent on connect; version mismatch → close(1002) |
| `welcome` | server→client | `{ clientId, groups: string[] }` — identity assigned to this connection (auth metadata or UUID) + its server-side groups |
| `subscribe` | client→server | `{ topic }` — join a room (server replies with replay history) |
| `unsubscribe` | client→server | `{ topic }` |
| `joinGroup` | client→server | `{ group }` — join a server-side group |
| `leaveGroup` | client→server | `{ group }` |
| `snapshotRequest` | client→server | `{ topic }` — reserved for future replay control |
| `ping` | client→server | `{ ts }` — heartbeat |
| `pong` | server→client | `{ ts }` |

Control ids are `fnv1a32` of the control name, dispatched via
`isControlId(id)` before user handlers.

## Rooms / topics

- `subscribe`/`unsubscribe` control frames manage server-side room membership.
- The server keeps an optional per-topic history (`replay: { historySize }`).
  On join it sends the recorded frames **oldest → newest** as a last-value
  snapshot, then live traffic follows. History is bounded (`historySize`),
  older frames are dropped.
- `publish` = global broadcast; `publishToTopic` = room only.

## Targeted delivery / groups

Every connection gets a stable **client id**: an explicit id from the
`authenticate` hook (`{ id, groups, meta }`) or an auto-generated UUID. The
server assigns it during the upgrade and delivers it in the `welcome` control
frame, so the client knows its own identity (`client.clientId`).

- `publishToClient(id, name, payload)` — send to ONE client by id (not bridged
to NATS).
- **Groups** are a server-side targeting dimension (no replay):
  - seeded from `authenticate` metadata (`{ groups: [...] }`),
  - managed programmatically (`joinGroup(id, group)` / `leaveGroup(id, group)`),
  - or joined by the client via the `joinGroup`/`leaveGroup` control frames.
- `publishToGroup(group, name, payload)` fans out to every member.
- Introspection: `getClient(id)` / `getClients()` / `groupMembers(group)` /
  `groups()` — also exposed as `GET /clients` on the server.

Rooms are client-joinable *subscriptions with optional replay*; groups are
server-side *targeting sets without replay*. Both are independent dimensions.

## NATS bridge

When `createServer({ nats: {...} })` is set, every broadcast / topic / group
publish is ALSO published to NATS as the **same wire frame** the WS clients
receive (encoded once, copied for NATS). Best-effort: if NATS is down the
frame is dropped and counted in `bridgeErrors` — the WS hot path never blocks.

| publish API | NATS subject |
| --- | --- |
| `publish(name, …)` | `{prefix}.broadcast.{name}` |
| `publishToTopic(topic, name, …)` | `{prefix}.topic.{topic}.{name}` |
| `publishToGroup(group, name, …)` | `{prefix}.group.{group}.{name}` |

`{prefix}` defaults to `ignex`. External apps push events INTO the hub by
publishing on `{prefix}.inbound.>` (default; configurable via
`inboundSubjects`); the server decodes them and forwards to all clients
(allowlisted by `inboundEvents`, control frames dropped, and never re-bridged —
no loops). `publishToClient` (single-socket) is intentionally not bridged.

Bridge state is observable via `server.getMetrics()`
(`natsStatus`, `bridged`, `bridgedBytes`, `bridgeErrors`, `bridgeInbound`).

### Decoding bridged frames (external consumers)

`bun run generate` emits `src/generated/wire-registry.json` — a machine-readable
`{ version, fingerprint, events: { name: id } }` map of the FNV-1a ids. A
consumer in any language:

1. reads `version` (byte 0) and `event_id` (bytes 1..5) from the frame,
2. maps `event_id` → name via `wire-registry.json`,
3. decodes the size-prefixed FlatBuffer from `frame[5..]` with a flatc build of
   `src/generated/fbs/backend.fbs`.

See `examples/nats-consumer.ts` for a working reference.

For YOUR OWN schema, `generateBindings` (see
[docs/generic-bindings.md](generic-bindings.md)) emits the same
`backend.fbs` + `wire-registry.json` into your project, plus a `fingerprint`
field — the cdylib and the generated registry share it, so a schema-mismatched
native addon fails the bind-time self-test instead of emitting undecodable
frames.

## Heartbeat

Clients send `ping` every `heartbeatMs` (default 15000). The server replies
`pong`. Bun's `idleTimeout` closes connections with no traffic, so pings keep
long-idle sockets alive; a client that misses `heartbeatMisses` pongs force-
closes and reconnects.

## Sequence / replay

The current model replays **recent history on subscribe** (bounded ring per
topic, last-value snapshot). Full gap-based replay (per-frame sequence numbers
in the envelope + `hello.lastSeq` negotiation) is a documented future extension;
the envelope reserves no space for a per-frame seq today.

## Security

- **Trust model**: the envelope has no checksum/AuthN. A hostile peer can lie
  about the event id; the decoder is fuzz-safe (never throws / OOB) but will
  happily decode the payload as the claimed type. Add integrity at the
  application layer if the wire crosses an untrusted boundary.
- Server-side guards (all optional): `authenticate(req)` async hook, origin
  allowlist, bearer `token`, `maxConnections`, `maxMessageSize`.
- Slow consumers: `backpressure` policy (`drop-oldest`/`drop-newest`/
  `disconnect`) bounds per-socket buffering; without it a hot publish loop can
  balloon memory.
- Injection: unknown object keys and prototype-pollution keys are dropped on
  both encode paths; embedded NULs route to the JSON path so they round-trip
  exactly (never silently truncated).

## Building an independent client

1. `bun run generate` produces `generated/fbs/backend.fbs` — the FlatBuffers
   schema for every table (app + control).
2. Compile that `.fbs` with flatc for your language: `flatc --python
   --gen-object-api ...`, `--cpp`, `--go`, etc.
3. Read `version` (byte 0) and `event_id` (bytes 1..5) from each binary frame.
   Compute ids with FNV-1a 32 over the name (see above) or read the emitted
   `src/generated/registry.ts` table.
4. `flatbuffers.ByteBuffer(frame[5..])` + `getSizePrefixedRootAs<T>` (or the
   language equivalent) gives you the payload.
5. Implement the control frames (at minimum `hello` + `ping`/`pong`) to be a
   good citizen; `subscribe` for rooms.

Wire compatibility is guaranteed by flatc: the Rust builders (server) and the
generated TS object API (browser client) both derive from the same `.fbs`.
