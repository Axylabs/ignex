# Realtime chat

Two realtime flavors in one example: an **SSE** ticker (server → client,
one-way) and a **nova typed chat bus** (both ways, per-user delivery). By
the end you'll know which to reach for.

**You'll need**: a dev server; for the chat half, `bun add @ignex/nova
@sinclair/typebox`.

## Part 1: SSE — the one-way stream

Create `src/routes/events/ticks.get.ts`:

```ts
// src/routes/events/ticks.get.ts → GET /events/ticks
import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";

export default get(() =>
  sse(async function* () {
    while (true) {
      yield { event: "tick", data: new Date().toISOString() };
      await Bun.sleep(1000);
    }
  }),
);
```

Open it in a browser tab (or `curl -N -k https://localhost:3000/events/ticks`)
and watch the ticks arrive — the generator drives everything: headers,
flushing, and cleanup when the client disconnects.

::: tip When SSE is enough
Live dashboards, notification feeds, progress bars — if the client never
talks back, SSE is simpler than WebSockets: plain HTTP, proxies friendly,
`EventSource` in five lines.
:::

## Part 2: nova — the typed chat bus

**1. Declare the wire contract** — `src/realtime.ts`:

```ts
// src/realtime.ts — the single source of truth for the wire
import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "chatdemo",
  events: {
    "chat.message": Type.Object({ to: Type.String(), body: Type.String() }),
    "chat.delivered": Type.Object({ id: Type.String() }),
  },
  clientToServer: ["chat.message"],
  serverToClient: ["chat.delivered"],
};
```

**2. Register the plugin** — `src/app.config.ts`:

```ts
import { jwtAuth, novaPlugin } from "@ignex/core";
import { bindings } from "../.ignex/sdk/realtime/index.js"; // generated

export const plugins: IgnexPlugin[] = [
  novaPlugin({
    port: 3001, // the WS port (separate from HTTP)
    path: "/ws",
    bindings,
    authenticate: jwtAuth({ secret: env.JWT_SECRET }), // reuse the auth stack
  }),
];
```

**3. Handle and emit — typed, no casts:**

```ts
// src/realtime/consumers/chat.ts (or anywhere in the app)
import { emitToUser, on } from "../lib/events.js"; // re-exports the generated facade

on("chat.message", (payload, ctx) => {
  // payload is typed: { to: string, body: string }
  emitToUser(payload.to, "chat.delivered", { id: ctx.messageId });
});
```

Try `on("chat.delivered", …)` instead — it's a **type error**: the
contract says only clients send `chat.message`, and only servers send
`chat.delivered`.

**4. The browser client** (from the generated realtime SDK):

```html
<script type="module">
  import { createRealtimeClient } from "/sdk/realtime/index.js";

  const client = createRealtimeClient("wss://localhost:3001/ws");
  client.on("chat.delivered", (p) => console.log("delivered", p.id));
  client.send("chat.message", { to: "u-42", body: "hi" });
</script>
```

## Scaffold it instead

The wizard does the whole dance — contract, plugin, publish route, example
consumer — and merges future events into the contract additively:

```sh
ignex event bus chat
```

## Which tier, when

| Tier | Direction | Best for |
| --- | --- | --- |
| **SSE** | server → client | feeds, tickers, notifications |
| **WebSockets** (raw) | both | protocol bridges, games, custom framing |
| **nova** | both, typed | chat, collaboration, per-user delivery, clusters |

Nova also scales across instances (NATS cluster sync) — see
[Deployment](../guide/deployment#4-scaling-out).

Next: [File upload](/examples/file-upload) — multipart bodies and static
downloads.
