/**
 * Server-side metrics counters — a `createMetrics()` factory returning a plain
 * counter object (no class, no `this`). Zero dependencies, no allocations in
 * the steady state (counters are plain numbers; `countPath` only allocates on
 * the first occurrence of an event name).
 */
export interface PathCounts {
  /** encodes that used the zero-alloc Rust FFI direct fast path */
  direct: number;
  /** encodes that fell back to the JSON path (nested/unions or disabled symbol) */
  json: number;
  /** encodes via the pure-JS encoder (user schema without a native addon) */
  js: number;
}

export interface MetricsSnapshot {
  /** encode calls (publish / publishTo / publishToTopic) */
  published: number;
  /** frames actually handed to a socket */
  sent: number;
  /** frames skipped because the socket was over its high-water mark (drop-newest) */
  droppedNewest: number;
  /** frames dropped from a slow socket's bounded queue (drop-oldest) */
  droppedOldest: number;
  /** slow consumers closed by the disconnect policy */
  disconnectedSlow: number;
  /** inbound app messages delivered to server.on() handlers */
  inbound: number;
  /** inbound control frames routed internally */
  inboundControl: number;
  /** undecodable / version-mismatched / unknown-id frames received */
  protocolErrors: number;
  bytesSent: number;
  /** per-event encode path counts (direct vs json vs js) */
  pathCounts: Record<string, PathCounts>;
  connectedClients: number;
  uptimeMs: number;
  /** NATS bridge counters (present only when a bridge is configured) */
  bridged?: number;
  bridgedBytes?: number;
  bridgeErrors?: number;
  bridgeInbound?: number;
  bridgeInboundErrors?: number;
  /** "connected" | "connecting" | "closed" (undefined when no bridge) */
  natsStatus?: string;
  /** events-layer counters (present only when `createServer({ events })` is used) */
  events?: import("../events/types").EventsMetricsSnapshot;
}

export interface Metrics {
  published: number;
  sent: number;
  droppedNewest: number;
  droppedOldest: number;
  disconnectedSlow: number;
  inbound: number;
  inboundControl: number;
  protocolErrors: number;
  bytesSent: number;
  readonly pathCounts: Map<string, PathCounts>;
  /** Count an encode on a given path for an event (direct = zero-alloc FFI). */
  countPath(name: string, path: "direct" | "json" | "js"): void;
  snapshot(connectedClients: number): MetricsSnapshot;
}

export function createMetrics(startedAt = Date.now()): Metrics {
  const pathCounts = new Map<string, PathCounts>();

  const m: Metrics = {
    published: 0,
    sent: 0,
    droppedNewest: 0,
    droppedOldest: 0,
    disconnectedSlow: 0,
    inbound: 0,
    inboundControl: 0,
    protocolErrors: 0,
    bytesSent: 0,
    pathCounts,
    countPath(name, path) {
      let pc = pathCounts.get(name);
      if (!pc) {
        pc = { direct: 0, json: 0, js: 0 };
        pathCounts.set(name, pc);
      }
      pc[path]++;
    },
    snapshot(connectedClients) {
      const pathCountsObj: Record<string, PathCounts> = {};
      for (const [name, pc] of pathCounts) pathCountsObj[name] = { ...pc };
      return {
        published: m.published,
        sent: m.sent,
        droppedNewest: m.droppedNewest,
        droppedOldest: m.droppedOldest,
        disconnectedSlow: m.disconnectedSlow,
        inbound: m.inbound,
        inboundControl: m.inboundControl,
        protocolErrors: m.protocolErrors,
        bytesSent: m.bytesSent,
        pathCounts: pathCountsObj,
        connectedClients,
        uptimeMs: Date.now() - startedAt,
      };
    },
  };

  return m;
}
