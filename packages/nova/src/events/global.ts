/**
 * Global emit — the module-level singleton the events layer exposes so ANY
 * module in the app can send events through websockets without holding a
 * server reference (the "global emit" of the events file pattern):
 *
 *   import { on, emit } from "ignex-nova/events";
 *   on("order.created", (ctx) => { ... });
 *   emit("quote", { symbol: "AAPL", ... });                       // broadcast
 *   emit("order", payload, { type: "group", group: "traders" });  // to a group
 *   emit("alert", payload, { type: "user", userId: "u-1" });      // to a user
 *
 * Bound automatically when `createServer({ events: {...} })` runs (last hub
 * wins — one active hub per process is the supported topology; use
 * `server.events` directly for per-server control). Calls before binding
 * throw a descriptive error; calls after `close()` are dropped silently.
 *
 * Typed against the BUILT-IN event registry. Custom-schema apps should use
 * `server.events.emit` / `server.events.on` (fully typed against YOUR events).
 */

import type { DefaultBindings } from "../bindings/types";
import type { EventName, Events } from "../schema";
import type { EmitTarget, EventContext, EventHandler, EventsHub } from "./types";

let bound: EventsHub | null = null;

/** Bind the singleton to a hub (called by the hub on creation). */
export function bindEvents(hub: EventsHub): void {
  bound = hub;
}

/** Unbind the singleton (called by the hub on close). */
export function unbindEvents(): void {
  bound = null;
}

export function isEventsBound(): boolean {
  return bound !== null;
}

/** The currently bound hub (null when none). */
export function getEventsHub(): EventsHub | null {
  return bound;
}

function requireHub(): EventsHub {
  if (!bound) {
    throw new Error(
      "ignex events: no events hub bound — pass `events: {}` to createServer() (or call bindEvents(hub) once)",
    );
  }
  return bound;
}

export function emit<K extends EventName>(name: K, payload: Events[K], target?: EmitTarget): void {
  requireHub().emit(name as never, payload as never, target);
}

export function emitToTopic<K extends EventName>(topic: string, name: K, payload: Events[K]): void {
  requireHub().emitToTopic(topic, name as never, payload as never);
}

export function emitToGroup<K extends EventName>(group: string, name: K, payload: Events[K]): void {
  requireHub().emitToGroup(group, name as never, payload as never);
}

export function emitToUser<K extends EventName>(userId: string, name: K, payload: Events[K]): void {
  requireHub().emitToUser(userId, name as never, payload as never);
}

export function emitToClient<K extends EventName>(
  clientId: string,
  name: K,
  payload: Events[K],
): void {
  requireHub().emitToClient(clientId, name as never, payload as never);
}

export function on<K extends EventName>(name: K, handler: EventHandler<DefaultBindings, K>): void {
  requireHub().on(name as never, handler as never);
}

export function off<K extends EventName>(
  name: K,
  handler?: EventHandler<DefaultBindings, K>,
): void {
  requireHub().off(name as never, handler as never);
}

export function once<K extends EventName>(
  name: K,
  handler: EventHandler<DefaultBindings, K>,
): void {
  requireHub().once(name as never, handler as never);
}

export function onAny(cb: (name: string, payload: unknown, ctx: EventContext) => void): void {
  requireHub().onAny(cb as never);
}

export function offAny(cb: (name: string, payload: unknown, ctx: EventContext) => void): void {
  requireHub().offAny(cb as never);
}

export function onServerEvent<K extends EventName>(
  name: K,
  handler: EventHandler<DefaultBindings, K>,
): void {
  requireHub().onServerEvent(name as never, handler as never);
}

export function offServerEvent<K extends EventName>(
  name: K,
  handler?: EventHandler<DefaultBindings, K>,
): void {
  requireHub().offServerEvent(name as never, handler as never);
}
