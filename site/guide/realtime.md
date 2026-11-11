# Realtime: SSE, WebSockets, nova

Three tiers, pick per feature: **SSE** when the client only listens,
**WebSockets** when it talks back with raw messages, **nova** when you want
typed pub/sub with rooms, per-user delivery, and cluster sync.

## Server-sent events (SSE)

An async generator is the whole handler — the framework handles headers,
flushing, and disconnects:

```ts
// src/routes/events/ping.get.ts → GET /events/ping
import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";

export default get(() =>
  sse(async function* () {
    yield { event: "ping", data: Date.now().toString() };
  }),
);
```

Consume it with the browser's `EventSource`:

```js
const source = new EventSource("/events/ping");
source.addEventListener("ping", (e) => console.log("ping at", e.data));
```

## WebSockets

`createWSHandler` builds a Bun `WebSocketHandler` with error containment
and **bounded dispatch** — a per-connection cap on concurrent unsettled
message handlers (default 256; at the cap the socket closes with `1013`
instead of queueing unbounded work):

```ts
// src/ws.example.ts (wired via config)
import { createWSHandler } from "@ignex/core";

export const wsHandler = createWSHandler({
  open(ws) {
    ws.send("Welcome to Ignex");
  },
  message(ws, message) {
    ws.send(String(message)); // echo
  },
});
```

Tune the limits (all optional, strictest-wins across routes):

```ts
export const wsHandler = createWSHandler(hooks, undefined, {
  maxInflightMessages: 64, // per connection (default 256)
  maxTotalInflightMessages: 512, // cap across this route's connections
  maxPayloadLength: 1024 * 1024, // per-frame bytes
  idleTimeout: 60, // seconds
});
```

One bad handler can't take down dispatch: every hook is wrapped so a
synchronous throw or an async rejection is contained and reported, never a
crash.

## nova: typed pub/sub (recommended for apps)

For real product features — chat, live dashboards, notifications — raw
message strings won't cut it. The `novaPlugin` bridge adds **typed
events**: a single wire contract, direction-aware typing (the server can't
`on()` an event it should broadcast), rooms, groups, per-user delivery, and
optional NATS cluster sync.

**1. Declare the contract** — the single source of truth for the wire:

```ts
// src/realtime.ts
import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "myapp",
  events: {
    "chat.message": Type.Object({ to: Type.String(), body: Type.String() }),
    "chat.delivered": Type.Object({ id: Type.String() }),
    "order.update": Type.Object({ orderId: Type.String() }),
  },
  // Separate SENDING from RECEIVING for stricter typing:
  clientToServer: ["chat.message"],
  serverToClient: ["chat.delivered", "order.update"],
};
```

**2. Register the plugin:**

```ts
// src/app.config.ts
import { jwtAuth, novaPlugin } from "@ignex/core";
import { bindings } from "../.ignex/sdk/realtime/index.js"; // generated

export const plugins: IgnexPlugin[] = [
  novaPlugin({
    port: 3001, // the WS server port
    path: "/ws",
    bindings, // your event registry
    authenticate: jwtAuth({ secret: env.JWT_SECRET }),
    // Cluster sync across instances (needs NATS running):
    // nats: { servers: ["nats://localhost:4222"] },
  }),
];
```

**3. Use it — typed, no casts:**

```ts
// anywhere in the app
import { emitToUser, on } from "./lib/events.js"; // re-exports the SDK facade

on("chat.message", (payload, ctx) => {
  emitToUser(payload.to, "chat.delivered", { id: payload.id });
});

// from a route or job:
emitToUser("u-42", "order.update", { orderId: "o-1" });
```

**4. On the client**, the generated SDK gives a typed client too:

```ts
import { createRealtimeClient } from "@acme/api-realtime-client";

const client = createRealtimeClient("wss://api.example.com/ws");
client.on("chat.delivered", (payload) => { ... });   // server→client only
client.send("chat.message", { to: "u-42", body: "hi" }); // client→server only
```

Sending vs receiving is enforced by the compiler: `on()` accepts only
`clientToServer` names, `emit*` only `serverToClient` — a mistake is a
type error, not a runtime surprise.

### Scaffolding a realtime feature

```sh
ignex event bus chat
# → src/realtime.ts, a pre-wired plugin, a publish route, and an example
#   consumer — new events merge into the contract additively, never overwrite
```

Install: `bun add @ignex/nova` (+ `@sinclair/typebox` for the contract).

## The wire: FlatBuffers, not JSON

nova events travel as **FlatBuffers** — an zero-copy binary format, not
JSON strings. Two practical consequences:

- **Clients decode in pure JS** — no FFI, no WebAssembly in the browser;
  the generated client decodes frames directly, so payload access stays
  allocation-light even at high event rates.
- **The server serializes through a Rust path** (`@ignex/nova`) for the
  hot emit path — typing stays enforced at both ends because the decoder
  reads the schema, not a convention.

## Codegen: contracts become code

The contract in `src/realtime.ts` is compiled, not interpreted:

1. `ignex build` (or `ignex sdk --platform realtime`) generates **typed
   bindings** from the contract into the local SDK
   (`.ignex/sdk/realtime/`) — the `bindings` the plugin consumes, the
   server facade (`on` / `emit*` re-exported by `src/lib/events.ts`), and
   the browser client with direction-aware `on`/`send` signatures.
2. FlatBuffer schema codegen uses `flatc` when it is on your `PATH`
   (offered automatically during scaffolding); without it, the pure-JS
   path still works — you just skip the native serializer.
3. `ignex sdk --platform realtime` ships the same typed client to
   frontend teams as an npm package — see the
   [SDK guide](./sdk#platforms).

Because bindings regenerate from the contract, adding an event is a
contract edit + rebuild — the wizard (`ignex event bus <name>`) merges new
events into `src/realtime.ts` additively so existing consumers never break.
Every event flowing through the hub is visible in the
[debugbar's Events panel](./debugbar#events-nats-nova-realtime-in-one-buffer)
(direction, target, size, payload preview) — and fireable from it for
testing.

::: tip Which tier for my feature?
Notifications or a live feed → **SSE** (simplest, proxy-friendly). Chat or
collaboration → **nova** (typing + rooms + presence are worth it). A
single protocol bridge or game socket → raw **WebSockets**.
:::
