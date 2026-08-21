/**
 * @fileoverview `ignex event` templates — event-driven scaffolding:
 *
 *   sse      → SSE stream endpoint (server → clients) + producer module
 *   webhook  → webhook receiver (clients → server, receives event data) + module
 *   bus      → typed in-process event bus (src/lib/events.ts) + publish route
 *              + example consumer module
 *
 * The module holds the business logic; the route file stays a thin HTTP layer
 * (the AOT compiler requires the handler to stay inline in the route module).
 */

/** Event wizard kinds. */
export const EVENT_KINDS = ["sse", "webhook", "bus"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** Validate a user-supplied event/resource name (kebab-case segment). */
export function validateEventName(name: string): string | undefined {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return "Use lowercase kebab-case (letters, digits, hyphens) — e.g. order-created.";
  }
  return undefined;
}

/** PascalCase helper for export names ("order-created" → "OrderCreated"). */
export const pascalFromKebab = (name: string): string =>
  name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");

/** `src/modules/events/<name>.get.ts` — SSE producer logic. */
export function eventSseModuleTemplate(name: string): string {
  const streamFn = `stream${pascalFromKebab(name)}`;
  return `import type { SSEMessage } from "@ignex/core";

/**
 * SSE event stream for clients subscribed to GET /events/${name}.
 *
 * Business logic lives here — replace the placeholder event with real data
 * (e.g. forwarded from your event bus or a DB change stream).
 */
export async function* ${streamFn}(): AsyncGenerator<SSEMessage> {
  yield { event: "${name}.updated", data: JSON.stringify({ at: Date.now() }) };
}
`;
}

/** `src/routes/events/<name>.get.ts` — thin SSE route. */
export function eventSseRouteTemplate(name: string): string {
  const streamFn = `stream${pascalFromKebab(name)}`;
  return `import { get } from "@ignex/core/http";
import { sse } from "@ignex/core";
import { ${streamFn} } from "../../modules/events/${name}.get.js";

export default get(() => sse(${streamFn}()));
`;
}

/** `src/modules/hooks/<name>.post.ts` — webhook receive logic. */
export function eventWebhookModuleTemplate(name: string): string {
  const fn = `handle${pascalFromKebab(name)}Event`;
  return `/**
 * Webhook receiver for ${name} events (POST /hooks/${name}).
 *
 * Business logic lives here — validate the payload, persist it, and fan it
 * out to the rest of the app (e.g. via src/lib/events.ts).
 */
export async function ${fn}(payload: unknown): Promise<void> {
  // TODO: validate + process the incoming event payload.
  console.log("received ${name} event:", payload);
}
`;
}

/** `src/routes/hooks/<name>.post.ts` — thin webhook receiver route. */
export function eventWebhookRouteTemplate(name: string): string {
  const fn = `handle${pascalFromKebab(name)}Event`;
  return `import { post } from "@ignex/core/http";
import { ${fn} } from "../../modules/hooks/${name}.post.js";

export default post(async (ctx) => {
  const payload = await ctx.body.json();
  await ${fn}(payload);
  return ctx.json({ received: true }, { status: 202 });
});
`;
}

/** `src/lib/events.ts` — typed realtime events over @ignex/nova. */
export function eventBusLibTemplate(): string {
  return `/**
 * Typed realtime events for ignex apps — built on @ignex/nova, the TypeBox
 * FlatBuffer transport (Rust FFI serializer, Bun WebSockets, NATS cluster
 * sync). Handlers and emits are typed against your events; the same wire
 * format serves browsers via the generated client.
 *
 *   import { emitToUser, on } from "./events.js";
 *
 *   on("order.created", (payload, ctx) => { ... });   // server-side handler
 *   await emitToUser("u-42", "order.created", order);  // push to a user's sockets
 *
 * Wire the server in src/app.config.ts:
 *   import { novaPlugin } from "@ignex/core";
 *   plugins: [ novaPlugin({ port: 3001, inbound: ["order.created"] }) ]
 *
 * Requires \`bun add @ignex/nova\`. The events layer is typed against the
 * BUILT-IN registry; for your own TypeBox schemas use
 * \`generateBindings(schema)\` from \`@ignex/nova/generate\`.
 */
export { emit, emitToClient, emitToGroup, emitToTopic, emitToUser, on, once, off } from "@ignex/nova/events";
`; // prettier-ignore
}

/** `src/routes/events/emit.<name>.post.ts` — publish route for the bus. */
export function eventBusEmitRouteTemplate(name: string): string {
  return `import { post } from "@ignex/core/http";
import { emit } from "../../lib/events.js";

export default post(async (ctx) => {
  const payload = await ctx.body.json();
  // Broadcast the event to every connected client (see novaPlugin options for
  // targeting: emitToUser / emitToGroup / emitToTopic).
  emit("${name}.created", payload);
  return ctx.json({ emitted: true }, { status: 202 });
});
`;
}

/** `src/modules/events/<name>.consumer.ts` — example bus consumer. */
export function eventBusConsumerTemplate(name: string): string {
  const fn = `start${pascalFromKebab(name)}Consumers`;
  return `import { on } from "../../lib/events.js";

/**
 * Example consumer for the "${name}.created" channel.
 *
 * Server-side handlers run in the events file (src/lib/events.ts) or here —
 * \`on()\` from @ignex/nova registers with the bound hub. Wire
 * \`${fn}()\` from your app bootstrap (e.g. src/app.config.ts).
 */
export function ${fn}(): () => void {
  const off = on("${name}.created", async (payload) => {
    // TODO: handle the ${name} event.
    console.log("${name}.created", payload);
  });
  return off;
}
`;
}

/** Per-kind file list (paths relative to `src/`). */
export function eventFiles(
  kind: EventKind,
  name: string,
): Array<{ path: string; content: string }> {
  switch (kind) {
    case "sse":
      return [
        { path: `modules/events/${name}.get.ts`, content: eventSseModuleTemplate(name) },
        { path: `routes/events/${name}.get.ts`, content: eventSseRouteTemplate(name) },
      ];
    case "webhook":
      return [
        { path: `modules/hooks/${name}.post.ts`, content: eventWebhookModuleTemplate(name) },
        { path: `routes/hooks/${name}.post.ts`, content: eventWebhookRouteTemplate(name) },
      ];
    case "bus":
      return [
        { path: "lib/events.ts", content: eventBusLibTemplate() },
        { path: `routes/events/emit.${name}.post.ts`, content: eventBusEmitRouteTemplate(name) },
        { path: `modules/events/${name}.consumer.ts`, content: eventBusConsumerTemplate(name) },
      ];
  }
}

/** Short summary shown after scaffolding. */
export function eventSummary(kind: EventKind, name: string): string {
  switch (kind) {
    case "sse":
      return `SSE stream ready at GET /events/${name} — clients receive "${name}.updated" events.`;
    case "webhook":
      return `Webhook receiver ready at POST /hooks/${name} — send event data there.`;
    case "bus":
      return `Typed realtime events ready (src/lib/events.ts via @ignex/nova) — add novaPlugin({ port: 3001, inbound: ["${name}.created"] }) to src/app.config.ts; POST /events/emit.${name} publishes "${name}.created" to connected clients.`;
  }
}
