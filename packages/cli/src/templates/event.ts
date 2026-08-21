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

/** `src/lib/events.ts` — typed in-process event bus. */
export function eventBusLibTemplate(): string {
  return `/**
 * Tiny typed in-process event bus for ignex apps.
 *
 * Use it to decouple producers from consumers without a broker:
 *   import { emit, on } from "./events.js";
 *
 *   on("order.created", async (order) => { ... });   // consumer
 *   await emit("order.created", order);               // producer
 *
 * For cross-service streaming, pair it with NATS (see \`ignex ops compose\`).
 */
type Handler<T> = (payload: T) => void | Promise<void>;

const handlers = new Map<string, Set<Handler<never>>>();

/** Subscribe to an event; returns an unsubscribe function. */
export function on<T>(event: string, handler: Handler<T>): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as Handler<never>);
  return () => off(event, handler);
}

/** Remove a subscription. */
export function off<T>(event: string, handler: Handler<T>): void {
  handlers.get(event)?.delete(handler as Handler<never>);
}

/** Publish an event to all subscribers (errors are propagated, not swallowed). */
export async function emit<T>(event: string, payload: T): Promise<void> {
  const set = handlers.get(event);
  if (!set) return;
  for (const handler of [...set]) {
    await (handler as Handler<T>)(payload);
  }
}

/** Number of active subscriptions (debugging / tests). */
export function listenerCount(event: string): number {
  return handlers.get(event)?.size ?? 0;
}
`;
}

/** `src/routes/events/emit.<name>.post.ts` — publish route for the bus. */
export function eventBusEmitRouteTemplate(name: string): string {
  return `import { post } from "@ignex/core/http";
import { emit } from "../../lib/events.js";

export default post(async (ctx) => {
  const payload = await ctx.body.json();
  await emit("${name}.created", payload);
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
 * Business logic lives here — wire \`${fn}()\` from your app bootstrap
 * (e.g. src/app.config.ts) and keep the returned unsubscribe around for tests.
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
      return `Typed event bus ready (src/lib/events.ts) — POST /events/emit.${name} publishes "${name}.created".`;
  }
}
