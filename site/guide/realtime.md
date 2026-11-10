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

::: tip Which tier for my feature?
Notifications or a live feed → **SSE** (simplest, proxy-friendly). Chat or
collaboration → **nova** (typing + rooms + presence are worth it). A
single protocol bridge or game socket → raw **WebSockets**.
:::
