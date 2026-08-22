/**
 * Cluster sync — horizontal scaling for the events layer.
 *
 * Every emit is delivered locally (synchronous, on the WS hot path) and then
 * re-published to a cluster channel so OTHER instances deliver it to their own
 * clients. All cross-instance work is deferred to the offload queue — the emit
 * call never blocks on a broker, and a slow/saturated broker never stalls the
 * socket loop.
 *
 * Self-describing envelope (routing never depends on broker channel syntax):
 *   [originLen:u8][origin:utf8][kind:u8][keyLen:u8][key:utf8][nameLen:u8][name:utf8][frame:bytes]
 *   kind: 0=broadcast 1=topic 2=group 3=user 4=client 5=presence
 *
 * The origin instance id gives self-delivery dedupe without broker no-local
 * semantics — every instance subscribes ONE channel (`{prefix}.cluster.>` /
 * `{prefix}.cluster.*` on Redis) and drops frames it published itself.
 *
 * Presence works with no shared state: join/leave messages + periodic
 * per-instance heartbeat, with TTL pruning. An optional `ClusterStateStore`
 * (Redis in production) additionally indexes user→clients, user-group
 * membership and client data cluster-wide, so any instance can answer
 * "who is online / in user group X / what data does client Y carry".
 */
import { createRequire } from "node:module";
import type { Bindings } from "../bindings/types";
import type { NatsBridge } from "../bridge/nats";
import type { TaskQueue } from "./queue";
import type {
  ClusterStateStore,
  ClusterTransport,
  EmitTargetKind,
  RedisConnectionOptions,
  RemoteClient,
} from "./types";

// ── envelope ────────────────────────────────────────────────────────────────

export const CLUSTER_KINDS = ["broadcast", "topic", "group", "user", "client", "presence"] as const;
export type ClusterKind = (typeof CLUSTER_KINDS)[number];
export const CLUSTER_KIND_ID: Record<ClusterKind, number> = {
  broadcast: 0,
  topic: 1,
  group: 2,
  user: 3,
  client: 4,
  presence: 5,
};

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface ClusterEnvelope {
  origin: string;
  kind: ClusterKind;
  key: string;
  name: string;
  frame: Uint8Array;
}

export function encodeClusterMessage(
  origin: string,
  kind: ClusterKind,
  key: string,
  name: string,
  frame: Uint8Array,
): Uint8Array {
  const o = enc.encode(origin);
  const k = enc.encode(key);
  const n = enc.encode(name);
  // header = [originLen][origin][kind][keyLen][key][nameLen][name] → 4 fixed bytes
  const out = new Uint8Array(4 + o.byteLength + k.byteLength + n.byteLength + frame.byteLength);
  let p = 0;
  out[p] = o.byteLength;
  p++;
  out.set(o, p);
  p += o.byteLength;
  out[p] = CLUSTER_KIND_ID[kind];
  p++;
  out[p] = k.byteLength;
  p++;
  out.set(k, p);
  p += k.byteLength;
  out[p] = n.byteLength;
  p++;
  out.set(n, p);
  p += n.byteLength;
  out.set(frame, p);
  return out;
}

export function decodeClusterMessage(bytes: Uint8Array): ClusterEnvelope | null {
  const read = (at: number): { len: number; str: string; next: number } | null => {
    if (at >= bytes.byteLength) return null;
    const len = bytes[at]!;
    if (at + 1 + len > bytes.byteLength) return null;
    return { len, str: dec.decode(bytes.subarray(at + 1, at + 1 + len)), next: at + 1 + len };
  };
  if (bytes.byteLength < 3) return null;
  const o = read(0);
  if (!o) return null;
  const kindId = bytes[o.next];
  if (kindId === undefined || kindId >= CLUSTER_KINDS.length) return null;
  const k = read(o.next + 1);
  if (!k) return null;
  const n = read(k.next);
  if (!n) return null;
  return {
    origin: o.str,
    kind: CLUSTER_KINDS[kindId]!,
    key: k.str,
    name: n.str,
    frame: bytes.subarray(n.next),
  };
}

// ── subjects ────────────────────────────────────────────────────────────────

export interface ClusterSubjects {
  /** the one channel every instance subscribes to */
  all(): string;
  /** publish channel for a target kind (also the external visibility of the subject space) */
  event(kind: EmitTargetKind, key: string | undefined, name: string): string;
}

export function createClusterSubjects(prefix: string): ClusterSubjects {
  const base = `${prefix}.cluster`;
  return {
    all: () => `${base}.>`,
    event: (kind, key, name) =>
      key === undefined ? `${base}.${kind}.${name}` : `${base}.${kind}.${key}.${name}`,
  };
}

// ── presence message payloads (kind = "presence", frame = JSON) ────────────

interface PresenceJoin {
  t: "j";
  i: string;
  c: string;
  u?: string;
  at: number;
}
interface PresenceLeave {
  t: "l";
  i: string;
  c: string;
}
interface PresenceSync {
  t: "s";
  i: string;
  at: number;
}
type PresenceMessage = PresenceJoin | PresenceLeave | PresenceSync;

function encodePresence(msg: PresenceMessage): Uint8Array {
  return enc.encode(JSON.stringify(msg));
}

function decodePresence(bytes: Uint8Array): PresenceMessage | null {
  try {
    return JSON.parse(dec.decode(bytes)) as PresenceMessage;
  } catch {
    return null;
  }
}

// ── cluster sync ───────────────────────────────────────────────────────────

export interface ClusterSyncOptions {
  instanceId: string;
  prefix: string;
  transport: ClusterTransport;
  queue: TaskQueue;
  bindings: Bindings;
  /** optional shared-state store (presence / groups / client data) */
  stateStore?: ClusterStateStore;
  /** remote presence TTL (ms) */
  presenceTtlMs: number;
  /** presence re-announce + prune cadence (ms) */
  heartbeatMs: number;
  /**
   * A valid remote frame must be delivered locally. `frame` is a view of the
   * message buffer — hand it to `ws.send`/replay immediately (Bun copies;
   * replay records an owned copy).
   */
  onRemoteFrame: (kind: EmitTargetKind, key: string, name: string, frame: Uint8Array) => void;
  onError?: (err: Error) => void;
}

export interface ClusterSync {
  /** offloaded cross-instance publish for a local emit (copies the scratch view) */
  publish(kind: EmitTargetKind, key: string | undefined, name: string, frame: Uint8Array): void;
  /** local connection joined/left → presence + state-store index (offloaded) */
  clientJoined(client: { id: string; userId?: string }): void;
  clientLeft(client: { id: string; userId?: string }): void;
  /** local client-group membership change → shared state store (offloaded) */
  clientGroupChanged(group: string, clientId: string, joined: boolean): void;
  /** user-group membership changed → shared state store (offloaded) */
  userGroupChanged(name: string, members: ReadonlySet<string>): void;
  /** cluster-wide clients of a user (state store), [] when none configured */
  clusterUserClients(userId: string): Promise<Array<{ instanceId: string; clientId: string }>>;
  /** cluster-wide client-group members (state store) */
  clusterGroupMembers(name: string): Promise<string[]>;
  /** cluster-wide user-group members (state store) */
  clusterUserGroupMembers(name: string): Promise<string[]>;
  /** write client data to the shared state store (offloaded) */
  setRemoteClientData(clientId: string, json: string): void;
  /** read client data from the shared state store */
  getRemoteClientData(clientId: string): Promise<Record<string, unknown> | undefined>;
  /** connections known on other instances (presence — no shared state needed) */
  remoteClients(): RemoteClient[];
  /** cluster counters (folded into hub.metrics()) */
  stats(): { received: number; droppedSelf: number; errors: number };
  close(): Promise<void>;
}

export function createClusterSync(opts: ClusterSyncOptions): ClusterSync {
  const { instanceId, prefix, transport, queue, bindings, stateStore } = opts;
  const subjects = createClusterSubjects(prefix);
  const remote = new Map<string, RemoteClient>(); // clientId → remote record
  const localUserIds = new Set<string>(); // this instance's users (state-store TTL refresh)
  const userGroupCache = new Map<string, Set<string>>();
  const userGroupStateKey = (name: string): string => `ignex:group-users:${name}`;
  const clientGroupStateKey = (name: string): string => `ignex:group:${name}`;
  const presenceUserKey = (userId: string): string => `ignex:presence:user:${userId}`;
  const presenceInstanceKey = (): string => `ignex:presence:instance:${instanceId}`;
  const clientDataKey = (clientId: string): string => `ignex:client-data:${clientId}`;
  let closed = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let received = 0;
  let droppedSelf = 0;
  let errors = 0;

  const reportError = (err: unknown): void => {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
  };

  // state-store ops are fire-and-forget through the offload queue
  const store = (op: () => Promise<unknown>): void => {
    if (!stateStore || closed) return;
    queue.enqueue(() => {
      void op().catch(reportError);
    });
  };

  const publishToCluster = (
    kind: ClusterKind,
    key: string,
    name: string,
    data: Uint8Array,
  ): void => {
    if (closed) return;
    // exact subject (subscribe side uses the wildcard; the envelope carries routing)
    const subject =
      kind === "presence"
        ? `${prefix}.cluster.presence`
        : subjects.event(kind as EmitTargetKind, key || undefined, name);
    queue.enqueue(() => {
      if (!transport.connected) {
        errors++; // offline broker — frames dropped, visible in metrics
        return;
      }
      try {
        transport.publish(subject, data);
      } catch {
        errors++;
      }
    });
  };

  // ── presence ──────────────────────────────────────────────────────────
  const announce = (msg: PresenceMessage): void => {
    // presence rides the SAME envelope as event frames (kind = "presence")
    const payload = encodeClusterMessage(instanceId, "presence", "", "", encodePresence(msg));
    publishToCluster("presence", "", "", payload);
  };

  const refreshRemoteInstance = (instance: string, at: number): void => {
    for (const r of remote.values()) {
      if (r.instanceId === instance) r.lastSeen = at;
    }
  };

  const handlePresence = (bytes: Uint8Array): void => {
    const msg = decodePresence(bytes);
    if (!msg) return;
    if (msg.t === "j") {
      if (msg.i === instanceId) return;
      remote.set(msg.c, {
        clientId: msg.c,
        instanceId: msg.i,
        ...(msg.u !== undefined ? { userId: msg.u } : {}),
        lastSeen: msg.at,
      });
      return;
    }
    if (msg.t === "l") {
      const r = remote.get(msg.c);
      if (r && r.instanceId === msg.i) remote.delete(msg.c);
      return;
    }
    if (msg.t === "s" && msg.i !== instanceId) refreshRemoteInstance(msg.i, msg.at);
  };

  const prune = (): void => {
    const ttl = opts.presenceTtlMs;
    const now = Date.now();
    for (const [clientId, r] of remote) {
      if (now - r.lastSeen > ttl) remote.delete(clientId);
    }
  };

  const heartbeat = (): void => {
    if (closed) return;
    prune();
    announce({ t: "s", i: instanceId, at: Date.now() });
    if (stateStore) {
      store(() => stateStore!.expire(presenceInstanceKey(), opts.presenceTtlMs));
      for (const userId of localUserIds)
        store(() => stateStore!.expire(presenceUserKey(userId), opts.presenceTtlMs));
    }
  };

  heartbeatTimer = setInterval(heartbeat, opts.heartbeatMs);

  // ── inbound ───────────────────────────────────────────────────────────
  const handleMessage = (data: Uint8Array): void => {
    const msg = decodeClusterMessage(data);
    if (!msg) {
      errors++; // undecodable envelope — counted once in stats()
      return;
    }
    if (msg.origin === instanceId) {
      droppedSelf++; // self-publish — already delivered locally
      return;
    }
    received++;
    if (msg.kind === "presence") {
      handlePresence(msg.frame);
      return;
    }
    const header = bindings.readFrameHeader(msg.frame);
    if (!header) {
      errors++;
      return;
    }
    opts.onRemoteFrame(msg.kind as EmitTargetKind, msg.key, header.name, msg.frame);
  };

  if (!closed) {
    unsubscribe = transport.subscribe(subjects.all(), handleMessage);
  }

  return {
    publish(kind, key, name, frame) {
      publishToCluster(
        kind,
        key ?? "",
        name,
        encodeClusterMessage(instanceId, kind, key ?? "", name, frame),
      );
    },
    clientJoined(client) {
      announce({
        t: "j",
        i: instanceId,
        c: client.id,
        ...(client.userId !== undefined ? { u: client.userId } : {}),
        at: Date.now(),
      });
      if (client.userId) localUserIds.add(client.userId);
      if (!stateStore) return;
      store(async () => {
        await stateStore!.sadd(presenceInstanceKey(), client.id);
        if (client.userId) {
          await stateStore!.sadd(presenceUserKey(client.userId), `${instanceId}:${client.id}`);
          await stateStore!.expire(presenceUserKey(client.userId), opts.presenceTtlMs);
        }
      });
    },
    clientLeft(client) {
      announce({ t: "l", i: instanceId, c: client.id });
      if (!stateStore) return;
      store(async () => {
        await stateStore!.srem(presenceInstanceKey(), client.id);
        if (client.userId)
          await stateStore!.srem(presenceUserKey(client.userId), `${instanceId}:${client.id}`);
      });
    },
    userGroupChanged(name, members) {
      if (!stateStore) return;
      const prev = userGroupCache.get(name) ?? new Set<string>();
      const key = userGroupStateKey(name);
      for (const m of members) {
        if (!prev.has(m)) store(() => stateStore!.sadd(key, m));
      }
      for (const m of prev) {
        if (!members.has(m)) store(() => stateStore!.srem(key, m));
      }
      userGroupCache.set(name, new Set(members));
    },
    clientGroupChanged(group, clientId, joined) {
      if (!stateStore) return;
      const key = clientGroupStateKey(group);
      store(() => (joined ? stateStore!.sadd(key, clientId) : stateStore!.srem(key, clientId)));
    },
    async clusterUserClients(userId) {
      if (!stateStore) return [];
      try {
        const members = await stateStore.smembers(presenceUserKey(userId));
        const out: Array<{ instanceId: string; clientId: string }> = [];
        for (const m of members) {
          const idx = m.indexOf(":");
          if (idx > 0) out.push({ instanceId: m.slice(0, idx), clientId: m.slice(idx + 1) });
        }
        return out;
      } catch (err) {
        reportError(err);
        return [];
      }
    },
    async clusterGroupMembers(name) {
      if (!stateStore) return [];
      try {
        return await stateStore.smembers(clientGroupStateKey(name));
      } catch (err) {
        reportError(err);
        return [];
      }
    },
    async clusterUserGroupMembers(name) {
      if (!stateStore) return [];
      try {
        return await stateStore.smembers(userGroupStateKey(name));
      } catch (err) {
        reportError(err);
        return [];
      }
    },
    setRemoteClientData(clientId, json) {
      if (!stateStore) return;
      store(() => stateStore!.set(clientDataKey(clientId), json, opts.presenceTtlMs));
    },
    async getRemoteClientData(clientId) {
      if (!stateStore) return undefined;
      try {
        const raw = await stateStore.get(clientDataKey(clientId));
        if (raw == null) return undefined;
        return JSON.parse(raw) as Record<string, unknown>;
      } catch (err) {
        reportError(err);
        return undefined;
      }
    },
    remoteClients() {
      return [...remote.values()];
    },
    stats() {
      return { received, droppedSelf, errors };
    },
    async close() {
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch {
          // already unsubscribed
        }
        unsubscribe = null;
      }
      await queue.drain();
      await transport.close();
    },
  };
}

// ── transport adapters ─────────────────────────────────────────────────────

/** Wrap the server's (or a dedicated) NATS bridge as a cluster transport. */
export function createNatsClusterTransport(bridge: NatsBridge): ClusterTransport {
  return {
    get connected(): boolean {
      return bridge.status === "connected";
    },
    publish(subject, data) {
      bridge.publish(subject, data); // copies bytes + counts bridge stats
    },
    subscribe(subject, cb) {
      return bridge.subscribeRaw(subject, cb);
    },
    close() {
      return Promise.resolve(); // the owning bridge decides its own lifecycle
    },
  };
}

const nodeRequire = createRequire(import.meta.url);

/** Synchronous optional loader for `ioredis` (never bundled). */
function loadRedis(): unknown {
  try {
    return nodeRequire("ioredis");
  } catch {
    throw new Error(
      "ignex events cluster: Redis configured but 'ioredis' is not installed — run `bun add ioredis` (or pass a custom cluster.transport / cluster.state)",
    );
  }
}

/**
 * Redis pub/sub cluster transport (lazy `ioredis`, optional peer dependency).
 * Binary-safe (Buffer replies via `returnBuffers`), pattern-subscribes the
 * cluster channel (`{prefix}.cluster.*`), fire-and-forget publishes — never
 * blocks the caller. Async publish failures are reported to `onError`.
 */
export function createRedisClusterTransport(
  opts: RedisConnectionOptions,
  onError?: (err: Error) => void,
): ClusterTransport {
  const Redis = loadRedis() as new (
    ...args: unknown[]
  ) => {
    publish(channel: string, data: Buffer): Promise<unknown>;
    subscribe(...channels: string[]): Promise<unknown>;
    psubscribe(...patterns: string[]): Promise<unknown>;
    unsubscribe(...channels: string[]): Promise<unknown>;
    punsubscribe(...patterns: string[]): Promise<unknown>;
    on(event: string, cb: (...args: unknown[]) => void): unknown;
    quit(): Promise<unknown>;
    readonly status: string;
  };
  const listeners = new Map<string, Set<(data: Uint8Array) => void>>();
  const patternListeners = new Map<string, Set<(data: Uint8Array) => void>>();
  let closed = false;
  const conn = (): { url?: string; options?: Record<string, unknown> } =>
    typeof opts === "string" ? { url: opts } : { options: opts };
  const make = (): InstanceType<typeof Redis> => {
    const c = conn();
    return c.url
      ? new Redis(c.url, { returnBuffers: true })
      : new Redis({ ...c.options, returnBuffers: true });
  };
  const pub = make();
  const sub = make();

  const toBytes = (msg: unknown): Uint8Array => {
    const b = msg instanceof Uint8Array ? msg : Buffer.from(String(msg));
    return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  };

  sub.on("message", (channel: unknown, msg: unknown) => {
    const cbs = listeners.get(String(channel));
    if (!cbs) return;
    const data = toBytes(msg);
    for (const cb of cbs) cb(data);
  });
  sub.on("pmessage", (_pattern: unknown, channel: unknown, msg: unknown) => {
    const cbs = patternListeners.get(String(channel));
    if (!cbs) return;
    const data = toBytes(msg);
    for (const cb of cbs) cb(data);
  });

  return {
    get connected(): boolean {
      return !closed && pub.status === "ready" && sub.status === "ready";
    },
    publish(subject, data) {
      if (closed) return;
      void pub
        .publish(subject, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
        .catch((err: unknown) => onError?.(err instanceof Error ? err : new Error(String(err))));
    },
    subscribe(subject, cb) {
      if (subject.includes(">")) {
        // NATS-style wildcard → Redis pattern subscription
        const pattern = subject.replace(/\.>+$/, ".*");
        let set = patternListeners.get(pattern);
        if (!set) {
          set = new Set();
          patternListeners.set(pattern, set);
          void sub.psubscribe(pattern);
        }
        set.add(cb);
        return () => {
          const s = patternListeners.get(pattern);
          if (!s) return;
          s.delete(cb);
          if (s.size === 0) {
            patternListeners.delete(pattern);
            void sub.punsubscribe(pattern);
          }
        };
      }
      let set = listeners.get(subject);
      if (!set) {
        set = new Set();
        listeners.set(subject, set);
        void sub.subscribe(subject);
      }
      set.add(cb);
      return () => {
        const s = listeners.get(subject);
        if (!s) return;
        s.delete(cb);
        if (s.size === 0) {
          listeners.delete(subject);
          void sub.unsubscribe(subject);
        }
      };
    },
    async close() {
      closed = true;
      listeners.clear();
      patternListeners.clear();
      await Promise.allSettled([pub.quit(), sub.quit()]);
    },
  };
}

// ── state-store adapters ────────────────────────────────────────────────────

/**
 * In-memory state store — per-process default. Pass a SHARED `Map` to simulate
 * a cross-instance store in tests / single-process multi-instance setups.
 */
export function createMemoryStateStore(
  shared?: Map<string, unknown>,
): ClusterStateStore & { close(): Promise<void> } {
  const data = shared ?? new Map<string, unknown>();
  const ttlKey = (key: string): string => `__ttl:${key}`;
  const alive = (key: string): boolean => {
    const ttl = data.get(ttlKey(key));
    if (ttl === undefined) return true;
    if (Date.now() > Number(ttl)) {
      data.delete(key);
      data.delete(ttlKey(key));
      return false;
    }
    return true;
  };

  return {
    async get(key) {
      if (!alive(key)) return null;
      const v = data.get(key);
      return typeof v === "string" ? v : null;
    },
    async set(key, value, ttlMs) {
      data.set(key, value);
      if (ttlMs !== undefined) data.set(ttlKey(key), Date.now() + ttlMs);
    },
    async del(key) {
      data.delete(key);
      data.delete(ttlKey(key));
    },
    async sadd(key, member) {
      let s = data.get(key);
      if (!(s instanceof Set)) {
        s = new Set<string>();
        data.set(key, s);
      }
      (s as Set<string>).add(member);
    },
    async srem(key, member) {
      const s = data.get(key);
      if (s instanceof Set) (s as Set<string>).delete(member);
    },
    async smembers(key) {
      if (!alive(key)) return [];
      const s = data.get(key);
      return s instanceof Set ? [...(s as Set<string>)] : [];
    },
    async expire(key, ttlMs) {
      data.set(ttlKey(key), Date.now() + ttlMs);
    },
    async close() {
      data.clear();
    },
  };
}

/** Redis state store (lazy `ioredis`). Called from the offload queue. */
export function createRedisStateStore(
  opts: RedisConnectionOptions = {},
): ClusterStateStore & { close(): Promise<void> } {
  const Redis = loadRedis() as new (
    ...args: unknown[]
  ) => {
    get(key: string): Promise<unknown>;
    set(...args: unknown[]): Promise<unknown>;
    del(...keys: string[]): Promise<unknown>;
    sadd(key: string, member: string): Promise<unknown>;
    srem(key: string, member: string): Promise<unknown>;
    smembers(key: string): Promise<unknown>;
    expire(key: string, seconds: number): Promise<unknown>;
    quit(): Promise<unknown>;
  };
  const r = new Redis(opts);
  return {
    async get(key) {
      const v = await r.get(key);
      return v == null ? null : String(v);
    },
    async set(key, value, ttlMs) {
      if (ttlMs !== undefined) await r.set(key, value, "PX", ttlMs);
      else await r.set(key, value);
    },
    async del(key) {
      await r.del(key);
    },
    async sadd(key, member) {
      await r.sadd(key, member);
    },
    async srem(key, member) {
      await r.srem(key, member);
    },
    async smembers(key) {
      const v = await r.smembers(key);
      return Array.isArray(v) ? v.map(String) : [];
    },
    async expire(key, ttlMs) {
      await r.expire(key, Math.max(1, Math.ceil(ttlMs / 1000)));
    },
    async close() {
      await r.quit();
    },
  };
}
