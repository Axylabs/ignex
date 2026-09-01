/**
 * @fileoverview Shared contracts for the debugbar serving layer (`debug/server`).
 *
 * The serving side is decomposed by domain (auth/assets/stream/handlers), and
 * every piece hangs off this one deps object — factories instead of classes,
 * explicit state instead of module globals.
 */

import type { IgnexRouter } from "../../http/router";
import type { ClientRegistry } from "../clients";
import type { LogStore } from "../logs";
import type { MetricsRegistry } from "../metrics";
import type { NatsEventTracker } from "../nats-tracker";
import type { ObservatoryDb } from "../persist";
import type { TraceStore } from "../store";
import type { SystemProfiler } from "../system";
import type { Trace } from "../tracer";

/** Live state of one debugbar instance (built once by the plugin factory). */
export interface DebugbarState {
  readonly enabled: boolean;
  readonly path: string;
  readonly captureBody: boolean;
  /** Null when the dashboard is not token-gated. */
  readonly token: string | null;
  readonly store: TraceStore;
  readonly profiler: SystemProfiler;
  readonly serviceName: string;
  readonly version: string;
  readonly manifestPaths: string[];
  readonly sdkPaths: string[];
  readonly docsPaths: string[];
  readonly projectRoot: string;
  readonly clientPaths: string[];
  readonly plugins: string[];
  readonly active: Map<string, Trace>;
  /** NATS event tracker (null when NATS is not configured). */
  readonly nats: NatsEventTracker | null;
  /** Published SDK + frontend-client registry (git tags + local probes). */
  readonly clients: ClientRegistry;
  /** Structured log ring (observatory Logs panel). */
  readonly logs: LogStore;
  /** Metrics registry (counters, gauges, per-route histograms). */
  readonly metrics: MetricsRegistry;
  /** SQLite observatory sink (null until opened; degrades to no-op). */
  sink: ObservatoryDb | null;
  /** Restore fn for console capture (null when not intercepting). */
  consoleRestore: (() => void) | null;
  router: IgnexRouter | null;
  /** Set once close() has run (idempotence guard). */
  closed: boolean;
  /** Event-loop delay probe interval (cleared by close()). */
  loopProbe: ReturnType<typeof setInterval> | null;
  /** `"METHOD /route"` → source file (AOT manifest); built lazily once. */
  routeFiles: Promise<ReadonlyMap<string, string>> | null;
  /** Best-effort dashboard URL logged at init (refined on first request). */
  bootUrl: string | null;
  /** Set once the exact URL has been logged (first traced request). */
  urlLogged: boolean;
}

/** Optional data providers wired through `debugbar({ data })`. */
export interface DataProviders {
  jobs?: { list(): Promise<Array<{ name: string; status: string; runAt: number }>> };
  routes?: () => Promise<Array<{ method: string; path: string; file: string }>>;
  nova?: () =>
    | {
        getEventTrace?(options?: { limit?: number; direction?: string; name?: string }): unknown;
        clearEventTrace?(): void;
      }
    | null
    | undefined;
}

/** Everything a serving-layer handler needs. */
export interface HandlerDeps {
  readonly state: DebugbarState;
  readonly data: DataProviders | undefined;
  /** Dispatch override for replay (most faithful in-process path). */
  readonly dispatch?: (req: Request) => Promise<Response>;
}

/** Minimal duck-typed nova handle the debugbar reads via `data.nova`. */
export interface NovaProbeHandle {
  getEventTrace?(options?: { limit?: number; direction?: string; name?: string }): unknown;
  clearEventTrace?(): void;
}
