/**
 * Server composition root — wires `createServerState` + the action modules
 * (auth / rooms / outbound / routing) into `Bun.serve`, and returns a plain
 * `IgnServer` API object (no class, no `this`). This is the ONLY place that
 * knows how the pieces fit together.
 *
 * Generic over the wire stack: `createServer({ bindings })` with your own
 * generated bindings types `publish` / `on` / ... against YOUR events. The
 * default is the built-in registry, so existing code keeps working unchanged.
 *
 * Public entry: `public/server.ts` re-exports `createServer` + the types.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf, EventsOf } from "../bindings/types";
import { createNatsBridge } from "../bridge/nats";
import { createEventsHub, type EventsHubInternal } from "../events/hub";
import type { EventsHub } from "../events/types";
import { checkUpgrade } from "./auth";
import {
  activeGroups,
  joinGroup as addToGroup,
  groupMembers as groupMemberIds,
  publishToGroup as publishToGroupState,
  leaveGroup as removeFromGroup,
} from "./groups";
import { setInt64GuardMode } from "./int64-guard";
import type { MetricsSnapshot } from "./metrics";
import { drainSocket, sendControl, sendFrame } from "./outbound";
import { joinRoom, leaveRoom, publishToRoom, roomTopics } from "./rooms";
import { handleMessage } from "./routing";
import { createServerState, type IgnServerOptions, type WsData } from "./state";

/** A snapshot of an active client (from `getClient` / `getClients` / GET /clients). */
export interface ClientInfo {
  id: string;
  /** identity this connection acts on behalf of (undefined if none) */
  userId?: string;
  /** arbitrary app metadata from `authenticate` (undefined if none) */
  meta?: Record<string, unknown>;
  /** server-side groups this client belongs to */
  groups: string[];
  /** topics/rooms this client has joined */
  topics: string[];
  /** epoch ms the socket connected */
  connectedAt: number;
  /** remote IP (from the socket) */
  ip: string;
}

function toClientInfo(ws: ServerWebSocket<WsData>): ClientInfo {
  return {
    id: ws.data.id,
    ...(ws.data.userId !== undefined ? { userId: ws.data.userId } : {}),
    ...(ws.data.meta !== undefined ? { meta: ws.data.meta } : {}),
    groups: [...ws.data.groups],
    topics: [...ws.data.topics],
    connectedAt: ws.data.connectedAt,
    ip: ws.remoteAddress,
  };
}

/** The public server API (returned by `createServer`). */
export interface IgnServer<B extends Bindings = DefaultBindings> {
  readonly port: number;
  readonly clientCount: number;
  getMetrics(): MetricsSnapshot;
  /** Broadcast a typed event to every connected client (zero-alloc on the happy path). */
  publish<K extends EventNameOf<B>>(name: K, payload: EventsOf<B>[K]): void;
  /** Send a typed event to a single socket (zero-alloc on the happy path). */
  publishTo<K extends EventNameOf<B>>(
    ws: ServerWebSocket<WsData>,
    name: K,
    payload: EventsOf<B>[K],
  ): void;
  /** Publish a typed event to every socket subscribed to `topic`. */
  publishToTopic<K extends EventNameOf<B>>(topic: string, name: K, payload: EventsOf<B>[K]): void;
  /** Send a typed event to a specific client by id. Returns false if that client is offline. */
  publishToClient<K extends EventNameOf<B>>(id: string, name: K, payload: EventsOf<B>[K]): boolean;
  /**
   * Allow clients to send `name` (adds it to the inbound allowlist at runtime).
   * The events layer calls this automatically when `server.events.on(name)` is
   * first used.
   */
  allowInbound<K extends EventNameOf<B>>(name: K): IgnServer<B>;
  /** Programmatic room membership (clients can also join via subscribe frames). */
  join(topic: string, ws: ServerWebSocket<WsData>): void;
  leave(topic: string, ws: ServerWebSocket<WsData>): void;
  /** Live topic names (with at least one subscriber). */
  topics(): string[];
  /** Server-side group membership (targeted fan-out, no replay). */
  joinGroup(id: string, group: string): void;
  leaveGroup(id: string, group: string): void;
  /** Publish a typed event to every client in a server-side group. */
  publishToGroup<K extends EventNameOf<B>>(group: string, name: K, payload: EventsOf<B>[K]): void;
  /** Live server-side group names (with at least one member). */
  groups(): string[];
  /** Client ids currently in `group`. */
  groupMembers(group: string): string[];
  /** Groups a client belongs to ([] if offline/unknown). */
  clientGroups(id: string): string[];
  /** Active-client introspection. */
  getClient(id: string): ClientInfo | undefined;
  getClients(): ClientInfo[];
  /** Force-close a specific client socket (e.g. from a policy / admin action). */
  closeClient(ws: ServerWebSocket<WsData>): void;
  /** Disconnect a client by id. Returns false if that client is offline. */
  disconnectClient(id: string): boolean;
  /** Register a handler for an inbound app event (must be in `options.inbound`). */
  on<K extends EventNameOf<B>>(
    name: K,
    handler: (payload: EventsOf<B>[K], ws: ServerWebSocket<WsData>) => void,
  ): IgnServer<B>;
  off<K extends EventNameOf<B>>(name: K): IgnServer<B>;
  /**
   * The events hub — present when `createServer({ events: {...} })` is used:
   * typed handlers (`server.events.on`), client records, groups, and the
   * cluster-aware emit surface.
   */
  readonly events: EventsHub<B> | undefined;
  /** Graceful drain: stop accepting, wait up to `timeoutMs` for queues to flush. */
  drain(timeoutMs?: number): Promise<void>;
  stop(force?: boolean): void;
}

export function createServer<B extends Bindings = DefaultBindings>(
  options: IgnServerOptions<B>,
): IgnServer<B> {
  const state = createServerState(options);
  setInt64GuardMode(options.int64Guard ?? "off");
  const bindings = state.bindings;

  // NATS bridge (optional, best-effort — created eagerly, connects in the background)
  const natsOpt = options.nats;
  if (natsOpt)
    state.bridge = "publish" in natsOpt ? natsOpt : createNatsBridge(natsOpt, undefined, bindings);

  // Encode once + broadcast to every connected client (NO bridge) — the shared
  // hot path for `publish` and NATS-inbound forwarding. Loop prevention: inbound
  // events reach clients but are never re-bridged to NATS.
  function fanOutAll(name: string, payload: unknown): Uint8Array {
    const frame = state.transport.encodeToScratch(name, payload);
    state.metrics.published++;
    for (const ws of state.sockets) sendFrame(state, ws, frame);
    return frame;
  }

  let eventsHub: EventsHubInternal<B> | undefined;

  if (state.bridge) {
    state.bridge.setOnInbound((name, payload) => {
      fanOutAll(name, payload);
      // server-side handling of externally-published events (the events layer)
      eventsHub?.dispatchBridgeInbound(name, payload);
    });
  }

  const bun = Bun.serve<WsData>({
    port: options.port,
    ...(options.hostname !== undefined ? { hostname: options.hostname } : {}),
    idleTimeout: options.idleTimeout ?? 30,
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    fetch: (req, srv) => {
      const url = new URL(req.url);
      if (url.pathname === state.path) return checkUpgrade(state, req, srv);
      if (url.pathname === "/health") {
        const h = state.metrics.snapshot(state.sockets.size);
        return new Response(
          JSON.stringify({ status: "ok", clients: h.connectedClients, uptimeMs: h.uptimeMs }),
          { headers: { "content-type": "application/json" } },
        );
      }
      if (url.pathname === "/clients") {
        return new Response(JSON.stringify([...state.clients.values()].map(toClientInfo)), {
          headers: { "content-type": "application/json" },
        });
      }
      if (options.fetch) return options.fetch(req);
      return new Response("not found", { status: 404 });
    },
    websocket: {
      open: (ws) => {
        state.sockets.add(ws);
        // belt-and-suspenders: an auth race could double-register an id — kick the stale session
        const existing = state.clients.get(ws.data.id);
        if (existing && existing !== ws) existing.close(1000, "replaced by newer session");
        state.clients.set(ws.data.id, ws);
        // events-layer attach (client record + presence) BEFORE group seeding
        state.onConnect?.(ws);
        for (const g of ws.data.groups) addToGroup(state, ws, g);
        // announce our wire version + capabilities so clients can negotiate
        sendControl(state, ws, "hello", { version: bindings.wireVersion, caps: [], lastSeq: 0 });
        // then assign identity so the client knows its id + server-side groups
        sendControl(state, ws, "welcome", { clientId: ws.data.id, groups: [...ws.data.groups] });
      },
      close: (ws) => {
        // events-layer detach FIRST (client record still carries groups/topics)
        state.onDisconnect?.(ws);
        state.sockets.delete(ws);
        state.clients.delete(ws.data.id);
        for (const g of ws.data.groups) removeFromGroup(state, ws, g);
        ws.data.groups.clear();
        for (const t of ws.data.topics) leaveRoom(state, ws, t);
        ws.data.topics.clear();
        delete ws.data.queue;
      },
      message: (ws, msg) => handleMessage(state, ws, msg),
      drain: (ws) => drainSocket(state, ws),
    },
  });

  const api: IgnServer<B> = {
    get port(): number {
      return bun.port ?? 0;
    },
    get clientCount(): number {
      return state.sockets.size;
    },
    getMetrics(): MetricsSnapshot {
      const stats = state.transport.getEncodeStats();
      for (const [name, n] of Object.entries(stats.direct)) {
        if (n > 0) state.metrics.countPath(name, "direct");
      }
      for (const [name, n] of Object.entries(stats.json)) {
        if (n > 0) state.metrics.countPath(name, "json");
      }
      for (const [name, n] of Object.entries(stats.js)) {
        if (n > 0) state.metrics.countPath(name, "js");
      }
      const snapshot = state.metrics.snapshot(state.sockets.size);
      const b = state.bridge;
      if (b) {
        snapshot.bridged = b.stats.bridged;
        snapshot.bridgedBytes = b.stats.bridgedBytes;
        snapshot.bridgeErrors = b.stats.bridgeErrors;
        snapshot.bridgeInbound = b.stats.bridgeInbound;
        snapshot.bridgeInboundErrors = b.stats.bridgeInboundErrors;
        snapshot.natsStatus = b.status;
      }
      if (eventsHub) snapshot.events = eventsHub.metrics();
      return snapshot;
    },
    publish(name, payload) {
      const frame = fanOutAll(name, payload);
      state.bridge?.publish(state.bridge.subjects.broadcast(name), frame);
    },
    publishTo(ws, name, payload) {
      state.metrics.published++;
      sendFrame(state, ws, state.transport.encodeToScratch(name, payload));
    },
    publishToTopic(topic, name, payload) {
      const frame = state.transport.encodeToScratch(name, payload);
      state.metrics.published++;
      publishToRoom(state, topic, frame);
      state.bridge?.publish(state.bridge.subjects.topic(topic, name), frame);
    },
    publishToClient(id, name, payload) {
      const ws = state.clients.get(id);
      if (!ws) return false;
      state.metrics.published++;
      sendFrame(state, ws, state.transport.encodeToScratch(name, payload));
      return true;
    },
    allowInbound(name) {
      state.inbound.add(name);
      return api;
    },
    join(topic, ws) {
      joinRoom(state, ws, topic);
    },
    leave(topic, ws) {
      leaveRoom(state, ws, topic);
    },
    topics() {
      return roomTopics(state);
    },
    joinGroup(id, group) {
      const ws = state.clients.get(id);
      if (ws) addToGroup(state, ws, group);
    },
    leaveGroup(id, group) {
      const ws = state.clients.get(id);
      if (ws) removeFromGroup(state, ws, group);
    },
    publishToGroup(group, name, payload) {
      const frame = state.transport.encodeToScratch(name, payload);
      state.metrics.published++;
      publishToGroupState(state, group, frame);
      state.bridge?.publish(state.bridge.subjects.group(group, name), frame);
    },
    groups() {
      return activeGroups(state);
    },
    groupMembers(group) {
      return groupMemberIds(state, group);
    },
    clientGroups(id) {
      const ws = state.clients.get(id);
      return ws ? [...ws.data.groups] : [];
    },
    getClient(id) {
      const ws = state.clients.get(id);
      return ws ? toClientInfo(ws) : undefined;
    },
    getClients() {
      return [...state.clients.values()].map(toClientInfo);
    },
    closeClient(ws) {
      ws.close(1000, "closed by server");
    },
    disconnectClient(id) {
      const ws = state.clients.get(id);
      if (!ws) return false;
      ws.close(1000, "closed by server");
      return true;
    },
    on(name, handler) {
      state.inboundHandlers.set(
        name,
        handler as (payload: unknown, ws: ServerWebSocket<WsData>) => void,
      );
      return api;
    },
    off(name) {
      state.inboundHandlers.delete(name);
      return api;
    },
    get events(): EventsHub<B> | undefined {
      return eventsHub;
    },
    async drain(timeoutMs = 2000): Promise<void> {
      bun.stop(false); // stop listening; keep active sockets draining
      await eventsHub?.close();
      await state.bridge?.close();
      const deadline = Date.now() + timeoutMs;
      while (state.sockets.size > 0 && Date.now() < deadline) {
        await Bun.sleep(10);
      }
      bun.stop(true);
    },
    stop(force = true): void {
      bun.stop(force);
      void eventsHub?.close();
      void state.bridge?.close();
    },
  };

  // ── events layer (opt-in) ─────────────────────────────────────────────
  if (options.events) {
    eventsHub = createEventsHub({
      state,
      server: api,
      bindings,
      ...(state.bridge !== undefined ? { serverBridge: state.bridge } : {}),
      options: options.events,
    });
    state.onConnect = (ws) => {
      eventsHub!.attach(ws);
    };
    state.onDisconnect = (ws) => {
      eventsHub!.detach(ws);
    };
    state.onGroupChange = (group, ws, joined) => {
      eventsHub!.onGroupChange(group, ws, joined);
    };
  }

  return api;
}
