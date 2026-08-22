/**
 * Client store — the live registry of active connections, "who is connected,
 * on whose behalf, and what the app remembers about them".
 *
 * - `byId: Map<clientId, EventClient>` — one record per socket.
 * - `byUser: Map<userId, Set<clientId>>` — the reverse "on what behalf" index,
 *   so a user with several tabs/devices is one logical target.
 * - Each record carries a per-connection `data` store (created on attach,
 *   dropped on detach) — `hub.setClientData` / `client.data` read/write it.
 *
 * Pure local state: cross-instance presence / state sync lives in `cluster.ts`
 * and is driven FROM this store via the `onAttach` / `onDetach` hooks (which
 * the hub wires to offloaded queue work, keeping connect/disconnect O(1)).
 */
import type { ServerWebSocket } from "bun";
import type { WsData } from "../core/state";
import { createClientData } from "./data";
import type { ClientData, EventClient } from "./types";

/** Factory for a client record bound to a live socket. */
export function createEventClient(ws: ServerWebSocket<WsData>): EventClient {
  const client: MutableEventClient = {
    get id(): string {
      return ws.data.id;
    },
    // `userId` is the identity this connection acts on behalf of — read live
    // from the socket data (single source of truth; `setUserId` writes there).
    get userId(): string | undefined {
      return ws.data.userId;
    },
    get meta(): Record<string, unknown> | undefined {
      return ws.data.meta;
    },
    data: createClientData(),
    get groups(): ReadonlySet<string> {
      return ws.data.groups;
    },
    get topics(): ReadonlySet<string> {
      return ws.data.topics;
    },
    get connectedAt(): number {
      return ws.data.connectedAt;
    },
    get ip(): string {
      return ws.remoteAddress;
    },
    // plain mutable property — the store flips it to true on detach
    closed: false,
    get ws(): ServerWebSocket<WsData> {
      return ws;
    },
  };
  return client;
}

/** The client record with readonly modifiers stripped (internal mutation). */
export type MutableEventClient = {
  -readonly [K in keyof EventClient]: EventClient[K];
};

export interface ClientStore {
  readonly size: number;
  attach(ws: ServerWebSocket<WsData>): EventClient;
  detach(ws: ServerWebSocket<WsData>): EventClient | undefined;
  get(id: string): EventClient | undefined;
  all(): EventClient[];
  byUser(userId: string): EventClient[];
  setUserId(clientId: string, userId: string): boolean;
  onAttach(cb: (client: EventClient) => void): void;
  onDetach(cb: (client: EventClient) => void): void;
}

export function createClientStore(): ClientStore {
  const byId = new Map<string, MutableEventClient>();
  const byUser = new Map<string, Set<string>>();
  const attachCbs: Array<(client: EventClient) => void> = [];
  const detachCbs: Array<(client: EventClient) => void> = [];

  const indexUser = (client: EventClient): void => {
    const userId = client.userId;
    if (!userId) return;
    let set = byUser.get(userId);
    if (!set) {
      set = new Set();
      byUser.set(userId, set);
    }
    set.add(client.id);
  };

  const unindexUser = (client: EventClient): void => {
    const userId = client.userId;
    if (!userId) return;
    const set = byUser.get(userId);
    if (!set) return;
    set.delete(client.id);
    if (set.size === 0) byUser.delete(userId);
  };

  return {
    get size(): number {
      return byId.size;
    },
    attach(ws) {
      const existing = byId.get(ws.data.id);
      if (existing) return existing;
      const client = createEventClient(ws);
      byId.set(client.id, client);
      indexUser(client);
      for (const cb of attachCbs) cb(client);
      return client;
    },
    detach(ws) {
      const client = byId.get(ws.data.id);
      if (!client) return undefined;
      byId.delete(client.id);
      unindexUser(client);
      client.closed = true;
      for (const cb of detachCbs) cb(client);
      return client;
    },
    get(id) {
      return byId.get(id);
    },
    all() {
      return [...byId.values()];
    },
    byUser(userId) {
      const ids = byUser.get(userId);
      if (!ids) return [];
      const out: EventClient[] = [];
      for (const id of ids) {
        const c = byId.get(id);
        if (c) out.push(c);
      }
      return out;
    },
    setUserId(clientId, userId) {
      const client = byId.get(clientId);
      if (!client) return false;
      client.ws.data.userId = userId;
      unindexUser(client);
      indexUser(client);
      return true;
    },
    onAttach(cb) {
      attachCbs.push(cb as (client: EventClient) => void);
    },
    onDetach(cb) {
      detachCbs.push(cb as (client: EventClient) => void);
    },
  };
}

export type { ClientData };
