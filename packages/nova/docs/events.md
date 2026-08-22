# Events layer — typed event-driven system on the FlatBuffer core

The events layer (`ignex-nova/events`, opt-in via `createServer({ events })`) is
the application-facing, event-driven surface on top of the transport: **an
events file receives events, and a global emit sends events through
websockets** — with first-class client records, named groups, and
cross-instance sync for horizontally scaled deployments.

Enable it (everything else is opt-in):

```ts
import { createServer } from "ignex-nova/server";

const server = createServer({
  port: 3000,
  events: {
    onConnect: (client) => client.data.set("connectedAt", client.connectedAt),
  },
});
```

`server.events` is the hub; the module-global singleton
(`ignex-nova/events`) is bound to it by default.

## The events file (receiving events)

Declare handlers like routes — a dedicated events file where inbound events
arrive. The handler receives the payload and a context describing **who sent
it and how to reply**:

```ts
// app/events.ts
import { on, emitToUser, emitToGroup } from "ignex-nova/events";

on("chat.message", (payload, ctx) => {
  // ctx.client — the sender's connection record (id, userId, data, groups…)
  // ctx.emit / ctx.emitToUser / … — reply without importing the singleton
  emitToUser(payload.to, "chat.delivered", { id: payload.id });
});

on("order.created", (payload, ctx) => {
  emitToGroup("backoffice", "order.alert", { orderId: payload.orderId });
});
```

- `hub.on(name, handler)` / `off` / `once` / `onAny` — multiple handlers per
  event, per-handler error isolation (one throwing handler never blocks the
  others; failures count in `metrics().handlerErrors`).
- `hub.onServerEvent(name, handler)` — server-side handling of events that
  arrive from OTHER instances or the NATS bridge (`ctx.source` is
  `"remote"`/`"bridge"`, `ctx.client` is undefined). Do NOT re-emit the same
  event from these handlers (loop).
- `on` auto-allows the event for inbound clients (`server.allowInbound`);
  `onAny` sees every event listed in `events.inbound`.

## The global emit (sending events through websockets)

`emit` and friends are importable anywhere — no server reference needed:

```ts
import { emit, emitToGroup, emitToUser, emitToClient, emitToTopic } from "ignex-nova/events";

emit("quote", { symbol: "AAPL", bid: 180.1, ask: 180.2 });          // broadcast
emitToGroup("traders", "alert", { text: "halt" });                  // group fan-out
emitToUser("u-42", "order.update", { orderId: "o-1" });             // user's sockets
emitToClient("c-123", "session.expired", { reason: "idle" });       // one connection
```

Or the discriminated `EmitTarget` — the API's way of **differentiating**
between addressing modes:

```ts
server.events.emit("quote", payload, { type: "group", group: "traders" });
server.events.emit("quote", payload, { type: "user", userId: "u-42" });
```

When the cluster is configured, every emit is cluster-aware: the target is
matched against clients on ALL instances.

## Client records — who is connected, on whose behalf

Each active connection is a `client` record:

```ts
interface EventClient {
  id: string;              // connection id (unique per socket)
  userId?: string;         // identity this connection acts ON BEHALF OF
  meta?: Record<string, unknown>; // auth metadata
  data: ClientData;        // per-connection app store (auto-cleared on close)
  groups: ReadonlySet<string>;    // client groups (shared with ws.data)
  topics: ReadonlySet<string>;    // joined topics (shared with ws.data)
  connectedAt: number; ip: string; closed: boolean; ws: ServerWebSocket;
}
```

- `userId` — "on what behalf": set from `authenticate` (`{ userId }`),
  `hub.setUserId(clientId, userId)`, or later. Several sockets may share one
  `userId` (multi-tab / multi-device); `hub.clientsByUser(userId)` groups
  them and `emitToUser` reaches all of them.
- `data` — per-connection state (`client.data.set(key, value)` or
  `hub.setClientData(clientId, key, value)`); with a shared state store it
  syncs cluster-wide (`hub.remoteClientData(clientId)`).
- `hub.client(id)` / `clients()` / `clientCount` — live introspection.
- Lifecycle hooks: `events.onConnect(client)` (seed data) and
  `events.onDisconnect(client)`.

## Groups — broadcast to groups vs individual users

Two group kinds, clearly differentiated:

| | `hub.group(name)` | `hub.userGroup(name)` |
|---|---|---|
| membership | connection ids | user ids |
| fan-out | members' sockets | every socket of each member user |
| shares transport groups | yes (`ws.data.groups`, control frames, `server.joinGroup`) | hub-managed |
| cluster membership | shared state store (`clusterGroupMembers`) | shared state store (`clusterUserGroupMembers`) |

```ts
const traders = server.events.group("traders");       // client group
traders.add(clientId); traders.remove(clientId);
traders.members(); traders.emit("quote", payload);

const ops = server.events.userGroup("ops");           // user group
ops.add("u-42"); ops.emit("alert", { text: "pager" }); // all of u-42's sockets
```

## Horizontal scaling (cluster sync)

When multiple instances share a broker, every emit is delivered to the
target's clients on every instance. Heavy work never runs on the hot path:
local delivery is synchronous (encode once via the transport scratch + `ws.send`),
everything else (broker publishes, state-store writes, presence maintenance) is
deferred to a bounded offload queue (`events.queue`, drop-newest on overflow).

- **NATS** (server ⇄ server): reuse the server bridge with
  `cluster: { nats: true }`, or a dedicated/different bridge
  (`nats: NatsBridgeOptions | NatsBridge`).
- **Redis**: `cluster: { redis: { url: "redis://…" } }` (lazy `ioredis`
  optional peer dependency — `bun add ioredis`).
- **Custom**: `cluster: { transport: MyClusterTransport }` (tests use an
  in-memory bus).
- Self-delivery dedupe: frames carry the origin `instanceId`
  (`cluster.instanceId`, random by default); an instance drops its own frames,
  so a broadcast is delivered exactly once per socket.
- **Presence with no shared state**: join/leave + periodic heartbeat messages
  — `hub.clusterClients()` lists connections on other instances.
- **Shared state store** (`cluster.state`, default per-instance memory;
  production: `createRedisStateStore(...)`): user→clients index
  (`clusterUserClients`), cluster group membership, cluster-wide client data.
- **Server-side events**: other instances' events reach `onServerEvent`
  handlers with `ctx.source === "remote"` (delivered to clients AND handlers);
  NATS-inbound events reach them with `source === "bridge"`.

## Metrics & shutdown

`server.getMetrics().events` (or `hub.metrics()`) exposes emitted counts per
target, delivered local frames, cluster received/self-dropped/errors,
queue and handler errors, presence sizes. `hub.close()` unsubscribes,
flushes the queue, announces leaves, and closes owned transports; call it via
`server.drain()` / `server.stop()`.

## Performance notes

- Zero-alloc local encode + fan-out (the transport scratch is reused; Bun
  copies on `ws.send`) — the emit call is O(target sockets).
- The cluster publish copies the frame once (required — the scratch is
  reused) and enqueues; a slow or offline broker never blocks the socket loop
  and never throws into it.
- Without `events`, there is zero overhead; the global functions throw a
  descriptive error if no hub is bound.
