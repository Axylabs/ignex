/**
 * @fileoverview `ignex event` templates — event-driven scaffolding:
 *
 *   sse      → SSE stream endpoint (server → clients) + producer module
 *   webhook  → webhook receiver (clients → server, receives event data) + module
 *   bus      → typed realtime event bus (src/lib/events.ts) + publish route
 *              + auto-registered consumer (src/realtime/consumers/)
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

/**
 * Validate a realtime EVENT name (the wire-contract key, e.g. `order.created`
 * or `order-created.created`). Dotted and kebab segments are both allowed —
 * event names routinely carry a `domain.action` shape.
 */
export function validateRealtimeEventName(name: string): string | undefined {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(name)) {
    return "Use a lowercase event name with dotted/kebab segments (e.g. order.created, chat.message).";
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

/** `src/realtime.ts` — the app's single wire-contract file (bus flow). */
export function eventBusRealtimeTemplate(name: string, eventName = `${name}.created`): string {
  return `/**
 * Realtime wire contract — the single source of truth for typed events.
 *
 * \`ignex build\` serializes this to .ignex/realtime.json; the generated SDK
 * (\`ignex sdk --platform realtime\`) derives the FlatBuffers wire stack, the
 * typed client, and the server-side typed facade from it. Extend \`events\`
 * with any other event name → TypeBox schema pair.
 */
import { Type } from "@sinclair/typebox";

export const realtime = {
  subjectPrefix: "${name}",
  events: {
    "${eventName}": Type.Object({
      id: Type.String(),
      at: Type.Integer(),
    }),
  },
  controlEvents: {},
};
`;
}

/** `src/realtime.plugin.ts` — pre-wired novaPlugin (bus flow). */
export function eventBusPluginTemplate(_name: string): string {
  return `import { novaPlugin } from "@ignex/core";
// Generated wire contract (bindings) — run \`ignex build\` after changing
// src/realtime.ts so the local SDK stays in sync.
import { bindings } from "../.ignex/sdk/realtime/index.js";

/**
 * Typed realtime transport (\`@ignex/nova\` over Bun WebSockets).
 *
 * Add to the plugins array in src/app.config.ts:
 *   import { realtimePlugin } from "./realtime.plugin.js";
 *   export const plugins = [ ..., realtimePlugin ];
 *
 * - \`events: {}\` enables the events layer (module-global emit/on/emitToUser).
 * - \`bindings\` teaches the registry your custom events — without it, emits
 *   fail with "unknown event".
 * - Replace \`authenticate\` with your own identity check (browser WebSockets
 *   cannot set Authorization headers, so tokens usually come via ?token=).
 */
export const realtimePlugin = novaPlugin({
  port: 3001,
  events: {},
  bindings,
  authenticate(req) {
    // Dev-friendly default: any ?token= becomes the client identity
    // (browser WebSockets cannot set Authorization headers). \`return true\`
    // allows anonymous connections — replace with a real verifier
    // (e.g. jwtAuth from @ignex/core) for production.
    const token = new URL(req.url).searchParams.get("token");
    if (token) return { id: token, userId: token };
    return true;
  },
});
`;
}

/** `src/lib/events.ts` - typed events facade re-exported from the generated SDK. */
export function eventBusLibTemplate(): string {
  return `/**
 * Typed realtime events — server-side facade generated by
 * \`ignex sdk --platform realtime\` from src/realtime.ts:
 *
 *   import { on, emit, emitToUser } from "./events.js";
 *
 *   on("<name>.created", async (payload, ctx) => { ... });   // hub handler
 *   await emitToUser("u-42", "<name>.created", order);         // push
 *
 * The facade is typed against YOUR events (no casts) and backed by the
 * module-global hub, which novaPlugin binds at boot. Handlers must be
 * registered AFTER the hub binds — the easiest path is dropping a module
 * under src/realtime/consumers/ that default-exports register(): the
 * compiled server imports it and calls register() automatically after the
 * plugin init loop (no manual post-realtimePlugin plugin needed).
 */
export * from "../../.ignex/sdk/realtime/server.js";
`;
}

/** `src/routes/events/emit.<name>.post.ts` — publish route for the bus. */
export function eventBusEmitRouteTemplate(name: string, eventName = `${name}.created`): string {
  return `import { post } from "@ignex/core/http";
import { emit } from "../../lib/events.js";
import type { RealtimeEventPayloads } from "../../lib/events.js";

export default post(async (ctx) => {
  // Validate/coerce the body to the event payload type (route schemas or
  // your own validation) before emitting — the facade enforces the type.
  const payload = (await ctx.body.json()) as RealtimeEventPayloads["${eventName}"];
  // Broadcast to every connected client (see realtime.plugin.ts for
  // targeting: emitToUser / emitToGroup / emitToTopic).
  emit("${eventName}", payload);
  return ctx.json({ emitted: true }, { status: 202 });
});
`;
}

/**
 * `src/realtime/consumers/<name>.consumer.ts` — auto-loaded bus consumer.
 *
 * Lives in the conventional realtime-consumers dir the compiler auto-registers
 * (default `src/realtime/consumers`): the compiled server imports every module
 * there and calls its default-exported `register()` right after `novaPlugin`
 * binds the events hub at boot — no manual post-`realtimePlugin` plugin and no
 * ordering footgun. `register()` may be async.
 */
export function eventBusConsumerTemplate(name: string, eventName = `${name}.created`): string {
  return `import { on } from "../../lib/events.js";

/**
 * Auto-loaded consumer for the "${eventName}" channel.
 *
 * \`on()\` registers with the hub \`novaPlugin\` binds at boot. Because this
 * file lives in \`src/realtime/consumers/\`, the compiled server imports it
 * and calls its default-exported \`register()\` automatically (right after
 * the plugin init loop) — dropping the file here is all the wiring needed.
 *
 * Payload is typed against src/realtime.ts: { id: string; at: number }.
 */
export default function register(): void {
  on("${eventName}", async (payload) => {
    // payload is typed: { id: string; at: number }
    console.log("${eventName}", payload);
  });
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
        { path: "realtime.ts", content: eventBusRealtimeTemplate(name) },
        { path: "realtime.plugin.ts", content: eventBusPluginTemplate(name) },
        { path: "lib/events.ts", content: eventBusLibTemplate() },
        { path: `routes/events/emit.${name}.post.ts`, content: eventBusEmitRouteTemplate(name) },
        { path: `realtime/consumers/${name}.consumer.ts`, content: eventBusConsumerTemplate(name) },
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
      return (
        `Typed realtime events scaffolded: src/realtime.ts (wire contract, declares "${name}.created") + ` +
        `src/realtime.plugin.ts (pre-wired novaPlugin) + publish route POST /events/emit.${name} + ` +
        `an auto-registered consumer in src/realtime/consumers/${name}.consumer.ts. Add realtimePlugin ` +
        `to src/app.config.ts, then \`ignex build\` regenerates the local SDK (.ignex/sdk) and the ` +
        `compiled server auto-loads the consumer (no manual wiring).`
      );
  }
}
