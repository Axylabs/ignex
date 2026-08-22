/**
 * Emit engine — the "global emit" hot path. Encodes ONCE through the transport
 * scratch (zero-alloc on the happy path), delivers to the target's local
 * sockets synchronously, then hands the SAME frame to the external bridge
 * (existing NATS broadcast/topic/group subjects) and the cluster sync
 * (offloaded) so other instances deliver it too.
 *
 * Hot-path guarantees:
 *   - encode + local delivery are synchronous and allocation-free (Bun copies
 *     on `ws.send`);
 *   - the bridge `publish` copies the scratch frame (never holds a stale view);
 *   - cluster work is enqueued on the offload queue — a slow broker can never
 *     stall the socket loop.
 */
import type { ServerWebSocket } from "bun";
import type { NatsBridge } from "../bridge/nats";
import { publishToGroup } from "../core/groups";
import { sendFrame } from "../core/outbound";
import { publishToRoom } from "../core/rooms";
import type { ServerState, WsData } from "../core/state";
import type { ClusterSync } from "./cluster";
import type { EmitTarget, EmitTargetKind } from "./types";

export interface EmitCounters {
  emitted: number;
  emittedByTarget: Record<EmitTargetKind, number>;
  deliveredLocal: number;
  clusterPublished: number;
}

export interface EmitEngine {
  emit(name: string, payload: unknown, target: EmitTarget): void;
}

export interface EmitterOptions {
  state: ServerState;
  bridge?: NatsBridge;
  cluster?: ClusterSync;
  /** local sockets acting on behalf of a userId (user-target delivery) */
  userSockets: (userId: string) => ServerWebSocket<WsData>[];
  counters: EmitCounters;
}

/** Deliver `frame` to the target's LOCAL sockets; returns the number written. */
export function deliverLocal(
  state: ServerState,
  target: EmitTarget,
  frame: Uint8Array,
  userSockets: (userId: string) => ServerWebSocket<WsData>[],
): number {
  switch (target.type) {
    case "broadcast": {
      for (const ws of state.sockets) sendFrame(state, ws, frame);
      return state.sockets.size;
    }
    case "topic": {
      const n = state.rooms.get(target.topic)?.size ?? 0;
      publishToRoom(state, target.topic, frame);
      return n;
    }
    case "group": {
      const n = state.groups.get(target.group)?.size ?? 0;
      publishToGroup(state, target.group, frame);
      return n;
    }
    case "user": {
      const list = userSockets(target.userId);
      for (const ws of list) sendFrame(state, ws, frame);
      return list.length;
    }
    case "client": {
      const ws = state.clients.get(target.clientId);
      if (!ws) return 0;
      sendFrame(state, ws, frame);
      return 1;
    }
  }
}

export function targetKey(target: EmitTarget): string | undefined {
  switch (target.type) {
    case "broadcast":
      return undefined;
    case "topic":
      return target.topic;
    case "group":
      return target.group;
    case "user":
      return target.userId;
    case "client":
      return target.clientId;
  }
}

export function createEmitter(opts: EmitterOptions): EmitEngine {
  const { state, bridge, cluster } = opts;

  const bridgeSubject = (target: EmitTarget, name: string): string | undefined => {
    switch (target.type) {
      case "broadcast":
        return bridge?.subjects.broadcast(name);
      case "topic":
        return bridge?.subjects.topic(target.topic, name);
      case "group":
        return bridge?.subjects.group(target.group, name);
      default:
        return undefined; // user/client targets are not bridged externally
    }
  };

  return {
    emit(name, payload, target) {
      const frame = state.transport.encodeToScratch(name, payload);
      opts.counters.emitted++;
      opts.counters.emittedByTarget[target.type]++;
      opts.counters.deliveredLocal += deliverLocal(state, target, frame, opts.userSockets);
      if (bridge) {
        const subject = bridgeSubject(target, name);
        if (subject) bridge.publish(subject, frame); // copies the scratch view
      }
      if (cluster) {
        opts.counters.clusterPublished++;
        cluster.publish(target.type, targetKey(target), name, frame);
      }
    },
  };
}
