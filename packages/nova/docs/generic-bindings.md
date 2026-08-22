# Generic bindings — bring your own schema

`ignex-nova` is schema-driven: **any** TypeBox schema you define in your app can
be turned into a full wire stack (FlatBuffers schema, TS decoders, pure-JS
encoder, Rust FFI fast path, NATS wire registry) with one function call —
`generateBindings(schema)` — and then served / consumed / bridged through the
same `createServer` / `createClient` / `createNatsBridge` APIs, fully typed
against **your** events.

```
your app
  src/schema.ts (TypeBox — source of truth)
        │  scripts/generate-bindings.ts
        │  import { generateBindings } from "ignex-nova/generate";
        ▼
  ignex/generated/  (backend.fbs, ts/decoders, registry.ts, ts-ser.ts,
                     direct-ser.ts, wire-registry.json, rust/ crate, index.ts)
        │  makeBindings(yourSchema) → Bindings
        ▼
  createServer({ bindings }) · createClient(url, { bindings }) · createNatsBridge({ bindings })
```

## 1. Define your schema (TypeBox)

```ts
// src/schema.ts — your app's single source of truth
import { Type } from "@sinclair/typebox";

export const ChatMsg = Type.Object(
  { room: Type.String(), text: Type.String(), ts: Type.Integer() },
  { additionalProperties: false },
);
export const Telemetry = Type.Object(
  { device: Type.String(), readings: Type.Array(Type.Number()), ok: Type.Boolean() },
  { additionalProperties: false },
);

export const schemas = { ChatMsg, Telemetry };
export const events = { chat: ChatMsg, telemetry: Telemetry };
export const controlEvents = {}; // optional extra transport-internal events
```

Rules (same as the built-in registry):

- `Type.Object({...}, { additionalProperties: false })` for payloads.
- `Type.Integer()` → int64; `Type.Integer({ bigint: true })` / `Type.BigInt()`
  → exact bigint int64 (lossless beyond 2^53).
- String-literal unions (`Type.Union([Type.Literal("a"), ...])`) → enums.
- Arrays of scalars / strings / enums / flat objects → vectors (packed on the
  direct fast path). Nested objects → tables. Tables-in-tables fall back to the
  JSON path.
- The transport control events (hello / welcome / subscribe / unsubscribe /
  joinGroup / leaveGroup / snapshotRequest / ping / pong) are ALWAYS included —
  you can add your own but cannot override the standard ones.

## 2. Generate bindings

```ts
// scripts/generate-bindings.ts — run once per schema change
import { generateBindings } from "ignex-nova/generate";
import { schemas, events, controlEvents } from "../src/schema";

const gen = generateBindings(
  { schemas, events, controlEvents },
  { outDir: "./ignex/generated" }, // default
);
const written = gen.write(); // e.g. 26 files under ignex/generated/
console.log("generated:", written.length, "files");
```

Requirements: `flatc` on PATH (the FlatBuffers compiler — the same prerequisite
as the built-in registry: `brew install flatbuffers` /
`apt install flatbuffers-compiler`). Pass `rust: false` to skip the Rust crate
scaffold (you lose the FFI fast path; the pure-JS encoder is still used).

The output folder contains:

| File | Role |
| --- | --- |
| `backend.fbs` | FlatBuffers schema (wire layout for independent consumers) |
| `ts/*.ts` | flatc-generated decoders (browser + Bun) |
| `registry.ts` | event ids, `readFrameHeader` / `decodePayload` / `decodeFrame`, `SCHEMA_FINGERPRINT` |
| `ts-ser.ts` | pure-JS encoder (works in the browser) |
| `direct-ser.ts` | direct fast-path serde (Bun server, when FFI is used) |
| `wire-registry.json` | machine-readable event-id registry for NATS consumers |
| `rust/` | a complete cargo crate — build it for the FFI fast path |
| `index.ts` | `makeBindings(schema)` — assembles the runtime `Bindings` |

## 3. Assemble the bindings and use the APIs

```ts
// bindings.ts
import { makeBindings } from "./ignex/generated"; // generated
import * as schema from "../src/schema";

export const bindings = makeBindings(schema);
export type AppEvents = import("ignex-nova").EventsOf<typeof bindings>;
```

```ts
// server.ts (Bun)
import { createServer } from "ignex-nova/server";
import { bindings } from "./bindings";

const server = createServer({
  port: 3000,
  bindings,
  inbound: ["chat"],                       // events clients may send
  nats: { servers: ["nats://localhost:4222"], inbound: true, bridgeClientEvents: true },
});
server.publish("chat", { room: "lobby", text: "hello", ts: Date.now() }); // typed!
server.on("chat", (msg, ws) => console.log(msg.room, msg.text));
```

```ts
// FE (browser or Bun)
import { createClient } from "ignex-nova/client";
import { bindings } from "./bindings";

const client = createClient("ws://localhost:3000/ws", { bindings });
client.on("telemetry", (t) => console.log(t.device, t.readings)); // typed!
client.send("chat", { room: "lobby", text: "hi from FE", ts: Date.now() });
client.connect();
```

The whole public surface is generic:

- `createServer({ bindings })` → `publish` / `publishToTopic` / `publishToGroup`
  / `on` / … typed against your `Events`.
- `createClient(url, { bindings })` → `on` / `send` / `once` / `onAny` / …
  typed against your `Events`.
- `createNatsBridge({ bindings })` → decodes inbound frames with your schema.

## Rust FFI fast path (optional)

By default generated bindings use `ffiMode: "optional"`: the server tries the
Rust addon only when you point `IGNEX_FFI_PATH` at one — otherwise it silently
uses the pure-JS encoder (correct everywhere, just not zero-allocation). To get
the fast path:

```bash
cd ignex/generated/rust
cargo build --release            # produces libignex_ffi.so/.dylib/.dll
IGNEX_FFI_PATH=$(pwd)/target/release/libignex_ffi.so bun run your-server.ts
```

The cdylib exports a **schema fingerprint** (`fb_schema_fingerprint`) that the
bind-time self-test checks against `SCHEMA_FINGERPRINT` in your generated
registry — a stale or schema-mismatched addon fails loudly instead of producing
undecodable frames. (`ffiMode: "required"` makes a missing/mismatched addon a
hard error.)

## NATS & horizontal scaling

Point every server instance at the same NATS and the same subject prefix, and
they behave as one hub:

- Every `publish` / `publishToTopic` / `publishToGroup` is ALSO published to
  NATS as the identical wire frame (`{prefix}.broadcast.<event>`,
  `{prefix}.topic.<topic>.<event>`, `{prefix}.group.<group>.<event>`) — any
  backend (BE) service can consume them with the wire registry +
  `backend.fbs`.
- External producers (or BE services) publish on `{prefix}.inbound.>`; every
  server forwards those events to its own clients.
- With `nats.bridgeClientEvents: true`, events that a client sends to ONE
  server are re-published to `{prefix}.inbound.<event>`, so all other servers'
  clients receive them too — client messages become cluster-wide. Loop
  prevention is built in: frames that arrive via NATS are forwarded to clients
  but never re-bridged.

```
             ┌─────────────┐  publish("chat", …)   ┌─────────────┐
 FE client ─▶│ server A    │──────▶ NATS ◀─────────│ server B    │◀─ FE client
             │ ignex.*     │                        │ ignex.*     │
             └─────────────┘                        └─────────────┘
                     │  inbound.<event> (client-sent, bridgeClientEvents)
                     └──────────────▶ BE consumers (any language)
```

Because the wire bytes are schema-derived, all instances must run the SAME
generated bindings (same event names → same FNV-1a ids). Changing the schema
changes the fingerprint — regenerate all instances together.

## Independent (non-JS) consumers

`wire-registry.json` maps event names → stable FNV-1a ids, and `backend.fbs`
is the FlatBuffer layout — decode bridged NATS frames in any language. See
`docs/wire-format.md` for the envelope.

## What about the built-in events?

The built-in registry (quote/trade/portfolio/…) is just the default
`Bindings` (`defaultBindings`); every API accepts `bindings` and defaults to
it, so existing code is untouched. Use the built-in events as a reference for
schema style — your app's schema works exactly the same way.
