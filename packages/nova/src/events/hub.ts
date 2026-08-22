/**
 * Events hub — composition root for the events layer. Created by
 * `createServer({ events: {...} })` (exposed as `server.events`) and, by
 * default, bound to the module-global `emit` / `on` singleton.
 *
 * Wires the pieces together:
 *   - `clients` — the active-connection registry (who is connected, on whose
 *     behalf, per-connection data);
 *   - `registry` — multi-handler dispatch (the events file receiving events);
 *   - `emitter` — encode-once + local fan-out + bridge + offloaded cluster;
 *   - `groups` — client groups (reusing the transport's group registry) and
 *     user groups;
 *   - `cluster` — optional cross-instance sync (NATS / Redis / custom) with
 *     presence + shared-state indexes, all off the hot path via the queue.
 *
 * Lifecycle is driven by the server: `attach`/`detach` on socket open/close,
 * `onGroupChange` on any group mutation (auth seed, control frames,
 * programmatic), `dispatchBridgeInbound` for NATS-inbound events.
 */
import type { ServerWebSocket } from "bun";
import type { Bindings, DefaultBindings, EventNameOf } from "../bindings/types";
import { createNatsBridge, type NatsBridge, type NatsBridgeOptions } from "../bridge/nats";
import type { IgnServer } from "../core/server";
import type { ServerState, WsData } from "../core/state";
import { createClientStore } from "./clients";
import {
  type ClusterSync,
  createClusterSync,
  createMemoryStateStore,
  createNatsClusterTransport,
  createRedisClusterTransport,
} from "./cluster";
import { createEmitter, deliverLocal, type EmitCounters } from "./emit";
import { bindEvents, unbindEvents } from "./global";
import { createGroupManager, type GroupManager } from "./groups";
import { createTaskQueue } from "./queue";
import { createHandlerRegistry } from "./registry";
import type {
  ClientGroup,
  ClusterStateStore,
  ClusterTransport,
  EmitTarget,
  EventClient,
  EventContext,
  EventHandler,
  EventSource,
  EventsClusterOptions,
  EventsHub,
  EventsMetricsSnapshot,
  EventsOptions,
  UserGroup,
} from "./types";

/** Internal surface the server drives (not part of the public `EventsHub`). */
export interface EventsHubInternal<B extends Bindings = DefaultBindings> extends EventsHub<B> {
  attach(ws: ServerWebSocket<WsData>): EventClient | undefined;
  detach(ws: ServerWebSocket<WsData>): EventClient | undefined;
  onGroupChange(group: string, ws: ServerWebSocket<WsData>, joined: boolean): void;
  dispatchBridgeInbound(name: string, payload: unknown): void;
}

export interface CreateEventsHubOptions<B extends Bindings> {
  state: ServerState;
  server: IgnServer<B>;
  bindings: Bindings;
  /** the server's own NATS bridge (reused by the cluster when `cluster.nats: true`) */
  serverBridge?: NatsBridge;
  options: EventsOptions<B>;
}

function resolveClusterTransport(
  opts: EventsClusterOptions,
  serverBridge: NatsBridge | undefined,
  bindings: Bindings,
  onError: (err: Error) => void,
): { transport?: ClusterTransport; ownBridge?: NatsBridge } {
  if (opts.transport) return { transport: opts.transport };
  if (opts.nats) {
    const nats = opts.nats;
    if (typeof nats === "boolean") {
      if (serverBridge) return { transport: createNatsClusterTransport(serverBridge) };
      const own = createNatsBridge(
        { servers: ["nats://localhost:4222"], inbound: false },
        undefined,
        bindings,
      );
      return { transport: createNatsClusterTransport(own), ownBridge: own };
    }
    if ("status" in nats) return { transport: createNatsClusterTransport(nats) };
    const own = createNatsBridge(nats as NatsBridgeOptions, undefined, bindings);
    return { transport: createNatsClusterTransport(own), ownBridge: own };
  }
  if (opts.redis) return { transport: createRedisClusterTransport(opts.redis, onError) };
  return {};
}

export function createEventsHub<B extends Bindings = DefaultBindings>(
  opts: CreateEventsHubOptions<B>,
): EventsHubInternal<B> {
  const { state, server, bindings, serverBridge } = opts;
  const eOpts = opts.options;
  const instanceId = eOpts.cluster?.instanceId ?? crypto.randomUUID();
  const prefix = eOpts.cluster?.prefix ?? bindings.subjectPrefix ?? "ignex";
  const queue = createTaskQueue({
    ...(eOpts.queue?.workers !== undefined ? { workers: eOpts.queue.workers } : {}),
    ...(eOpts.queue?.maxPending !== undefined ? { maxPending: eOpts.queue.maxPending } : {}),
  });
  const counters: EmitCounters = {
    emitted: 0,
    emittedByTarget: { broadcast: 0, topic: 0, group: 0, user: 0, client: 0 },
    deliveredLocal: 0,
    clusterPublished: 0,
  };
  let transportErrors = 0;
  let closed = false;
  let boundGlobal = false;

  const clients = createClientStore();
  const registry = createHandlerRegistry();
  const dispatchers = new Set<string>();

  // ── cluster ───────────────────────────────────────────────────────────
  const reportClusterError = (err: Error): void => {
    transportErrors++;
    void err;
  };

  let cluster: ClusterSync | undefined;
  let ownBridge: NatsBridge | undefined;
  let stateStore: ClusterStateStore | undefined;
  if (eOpts.cluster) {
    const resolved = resolveClusterTransport(
      eOpts.cluster,
      serverBridge,
      bindings,
      reportClusterError,
    );
    if (!resolved.transport) {
      throw new Error(
        "ignex events: cluster configured without a transport — set cluster.nats, cluster.redis, or cluster.transport",
      );
    }
    ownBridge = resolved.ownBridge;
    stateStore = eOpts.cluster.state ?? createMemoryStateStore();
    cluster = createClusterSync({
      instanceId,
      prefix,
      transport: resolved.transport,
      queue,
      bindings,
      stateStore,
      presenceTtlMs: eOpts.cluster.presenceTtlMs ?? 60_000,
      heartbeatMs: eOpts.cluster.heartbeatMs ?? 15_000,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cluster frame fan-out is inherently branchy
      onRemoteFrame: (kind, key, name, frame) => {
        let target: EmitTarget;
        if (kind === "broadcast") target = { type: "broadcast" };
        else if (kind === "topic") target = { type: "topic", topic: key };
        else if (kind === "group") target = { type: "group", group: key };
        else if (kind === "user") target = { type: "user", userId: key };
        else target = { type: "client", clientId: key };
        counters.deliveredLocal += deliverLocal(state, target, frame, userSockets);
        if (registry.wantsServerEvent(name)) {
          const id = bindings.anyEventNameToId[name];
          if (id !== undefined) {
            try {
              registry.dispatchServerEvent(
                name,
                bindings.decodePayload(id, frame),
                makeCtx(undefined, "remote"),
              );
            } catch (err) {
              reportClusterError(err instanceof Error ? err : new Error(String(err)));
            }
          }
        }
      },
      onError: reportClusterError,
    });
  }

  // ── emitter ───────────────────────────────────────────────────────────
  const userSockets = (userId: string): ServerWebSocket<WsData>[] =>
    clients.byUser(userId).map((c) => c.ws);
  const emitter = createEmitter({
    state,
    ...(serverBridge !== undefined ? { bridge: serverBridge } : {}),
    ...(cluster !== undefined ? { cluster } : {}),
    userSockets,
    counters,
  });

  // ── groups ────────────────────────────────────────────────────────────
  const groups: GroupManager<B> = createGroupManager<B>({
    state,
    emitToGroup: (group, name, payload) => api.emitToGroup(group, name as never, payload as never),
    emitToUser: (userId, name, payload) => api.emitToUser(userId, name as never, payload as never),
    onUserGroupChange: (name, members) => cluster?.userGroupChanged(name, members),
  });

  // ── context factory ───────────────────────────────────────────────────
  const makeCtx = (client: EventClient | undefined, source: EventSource): EventContext<B> => {
    const ctx: EventContext<B> = {
      source,
      hub: api,
      server,
      emit: (name, payload, target) => api.emit(name as never, payload as never, target),
      emitToGroup: (group, name, payload) =>
        api.emitToGroup(group, name as never, payload as never),
      emitToUser: (userId, name, payload) =>
        api.emitToUser(userId, name as never, payload as never),
      emitToClient: (clientId, name, payload) =>
        api.emitToClient(clientId, name as never, payload as never),
      emitToTopic: (topic, name, payload) =>
        api.emitToTopic(topic, name as never, payload as never),
      ...(client ? { client } : {}),
    };
    return ctx;
  };

  // ── inbound dispatch (client-sent events → handlers) ──────────────────
  const dispatchClientEvent = (
    name: string,
    payload: unknown,
    ws: ServerWebSocket<WsData>,
  ): void => {
    const client = clients.get(ws.data.id) ?? attach(ws);
    registry.dispatch(name, payload, makeCtx(client, "client"));
  };

  const ensureDispatcher = (name: string): void => {
    if (dispatchers.has(name)) return;
    dispatchers.add(name);
    server.allowInbound(name as never);
    server.on(
      name as never,
      ((payload: unknown, ws: ServerWebSocket<WsData>) =>
        dispatchClientEvent(name, payload, ws)) as never,
    );
  };

  // ── client lifecycle ──────────────────────────────────────────────────
  const attach = (ws: ServerWebSocket<WsData>): EventClient | undefined => {
    const client = clients.attach(ws);
    if (!client) return undefined;
    cluster?.clientJoined({
      id: client.id,
      ...(client.userId !== undefined ? { userId: client.userId } : {}),
    });
    eOpts.onConnect?.(client);
    return client;
  };

  const detach = (ws: ServerWebSocket<WsData>): EventClient | undefined => {
    const client = clients.detach(ws);
    if (!client) return undefined;
    cluster?.clientLeft({
      id: client.id,
      ...(client.userId !== undefined ? { userId: client.userId } : {}),
    });
    eOpts.onDisconnect?.(client);
    return client;
  };

  const onGroupChange = (group: string, ws: ServerWebSocket<WsData>, joined: boolean): void => {
    cluster?.clientGroupChanged(group, ws.data.id, joined);
  };

  // ── the hub API ───────────────────────────────────────────────────────
  const api: EventsHubInternal<B> = {
    get server(): IgnServer<B> {
      return server;
    },
    get instanceId(): string {
      return instanceId;
    },

    on(name, handler) {
      ensureDispatcher(name);
      registry.on(name, handler as never);
      return api;
    },
    off(name, handler) {
      registry.off(name, handler as never);
      return api;
    },
    once(name, handler) {
      ensureDispatcher(name);
      registry.once(name, handler as never);
      return api;
    },
    onAny(cb) {
      registry.onAny(cb as never);
      return api;
    },
    offAny(cb) {
      registry.offAny(cb as never);
      return api;
    },
    onServerEvent(name, handler) {
      registry.onServerEvent(name, handler as never);
      return api;
    },
    offServerEvent(name, handler) {
      registry.offServerEvent(name, handler as never);
      return api;
    },
    events() {
      return registry.names() as EventNameOf<B>[];
    },
    listenerCount(name) {
      return registry.count(name);
    },
    removeAllListeners(name) {
      registry.removeAll(name);
      return api;
    },

    emit(name, payload, target = { type: "broadcast" }) {
      if (closed) return;
      emitter.emit(name as never, payload as never, target);
    },
    emitToTopic(topic, name, payload) {
      api.emit(name, payload, { type: "topic", topic });
    },
    emitToGroup(group, name, payload) {
      api.emit(name, payload, { type: "group", group });
    },
    emitToUser(userId, name, payload) {
      api.emit(name, payload, { type: "user", userId });
    },
    emitToClient(clientId, name, payload) {
      api.emit(name, payload, { type: "client", clientId });
    },

    client(id) {
      return clients.get(id);
    },
    clients() {
      return clients.all();
    },
    clientsByUser(userId) {
      return clients.byUser(userId);
    },
    get clientCount(): number {
      return clients.size;
    },
    setUserId(clientId, userId) {
      const before = clients.get(clientId)?.userId;
      if (!clients.setUserId(clientId, userId)) return;
      if (before !== userId) {
        cluster?.clientLeft({
          id: clientId,
          ...(before !== undefined ? { userId: before } : {}),
        });
        cluster?.clientJoined({
          id: clientId,
          ...(userId !== undefined ? { userId } : {}),
        });
      }
    },
    setClientData(clientId, key, value) {
      const client = clients.get(clientId);
      if (!client) return;
      client.data.set(key, value);
      cluster?.setRemoteClientData(clientId, JSON.stringify(client.data.toJSON()));
    },
    getClientData(clientId, key) {
      return clients.get(clientId)?.data.get(key);
    },
    clearClientData(clientId) {
      const client = clients.get(clientId);
      if (!client) return;
      client.data.clear();
      cluster?.setRemoteClientData(clientId, "{}");
    },

    group(name) {
      return groups.clientGroup(name);
    },
    groups() {
      return groups.clientGroups();
    },
    userGroup(name) {
      return groups.userGroup(name);
    },
    userGroups() {
      return groups.userGroups();
    },

    clusterClients() {
      return cluster?.remoteClients() ?? [];
    },
    async clusterUserClients(userId) {
      return (await cluster?.clusterUserClients(userId)) ?? [];
    },
    async clusterGroupMembers(group) {
      return (await cluster?.clusterGroupMembers(group)) ?? [];
    },
    async clusterUserGroupMembers(group) {
      return (await cluster?.clusterUserGroupMembers(group)) ?? [];
    },
    async remoteClientData(clientId) {
      return await cluster?.getRemoteClientData(clientId);
    },

    metrics() {
      const s = cluster?.stats();
      const q = queue.stats();
      const out: EventsMetricsSnapshot = {
        emitted: counters.emitted,
        emittedByTarget: { ...counters.emittedByTarget },
        deliveredLocal: counters.deliveredLocal,
        clusterPublished: counters.clusterPublished,
        clusterReceived: s?.received ?? 0,
        clusterDroppedSelf: s?.droppedSelf ?? 0,
        clusterErrors: (s?.errors ?? 0) + transportErrors,
        queueQueued: q.queued,
        queueDropped: q.dropped,
        queueErrors: q.errors,
        handlerErrors: registry.errorCount,
        connectedClients: clients.size,
        remoteClients: cluster?.remoteClients().length ?? 0,
        clientGroups: groups.clientGroups().length,
        userGroups: groups.userGroups().length,
      };
      return out;
    },
    queueStats() {
      const s = queue.stats();
      return { pending: queue.pending, ...s };
    },

    // ── internals (server-driven) ───────────────────────────────────────
    attach,
    detach,
    onGroupChange,
    dispatchBridgeInbound(name, payload) {
      if (registry.wantsServerEvent(name)) {
        registry.dispatchServerEvent(name, payload, makeCtx(undefined, "bridge"));
      }
    },

    async close() {
      if (closed) return;
      closed = true;
      if (boundGlobal) unbindEvents();
      // announce local leaves so remote presence converges before we shut down
      for (const c of clients.all())
        cluster?.clientLeft({
          id: c.id,
          ...(c.userId !== undefined ? { userId: c.userId } : {}),
        });
      await cluster?.close();
      await queue.drain();
      queue.close();
      if (ownBridge) await ownBridge.close();
    },
  };

  if (eOpts.global !== false) {
    bindEvents(api as never);
    boundGlobal = true;
  }

  // pre-register dispatchers for explicitly allowed inbound events (so onAny
  // sees them even without a dedicated handler)
  for (const name of eOpts.inbound ?? []) ensureDispatcher(name);

  return api;
}

export type {
  ClientGroup,
  ClusterStateStore,
  EmitTarget,
  EventHandler,
  EventsHub,
  EventsOptions,
  UserGroup,
};
