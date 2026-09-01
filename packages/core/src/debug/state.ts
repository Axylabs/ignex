/**
 * @fileoverview App-state snapshot builder for the observatory.
 *
 * A pure assembler that turns process + plugin data into one
 * {@link AppStateSnapshot} document (`GET {path}/api/state`): runtime and
 * memory facts, environment variable NAMES (values are never included),
 * route/plugin inventory and the live store sizes. Dependency-injected so
 * it stays testable without a real server.
 */

import type { AppStateSnapshot } from "./types";

/** Everything the snapshot needs from the plugin (already computed there). */
export interface AppStateInput {
  readonly serviceName: string;
  readonly version: string;
  readonly debugMode: boolean;
  /** Route count from the KT knowledge / router map. */
  readonly routeCount: number;
  readonly plugins: string[];
  readonly tracesRetained: number;
  readonly logsRetained: number;
  readonly activeRequests: number;
  readonly features: { logs: boolean; metrics: boolean; persist: boolean };
}

const mib = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Build the app-state snapshot. Reads `process.*` facts directly (cheap,
 * synchronous) and takes everything else from {@link AppStateInput}.
 */
export const buildAppState = (input: AppStateInput): AppStateSnapshot => {
  const mem = process.memoryUsage();
  return {
    service: input.serviceName,
    version: input.version,
    environment: process.env.NODE_ENV ?? "development",
    debugMode: input.debugMode,
    runtime: {
      bunVersion: typeof Bun !== "undefined" ? Bun.version : (process.versions?.bun ?? "unknown"),
      platform: process.platform,
      arch: process.arch,
      pid: process.pid,
      nodeEnv: process.env.NODE_ENV ?? "unset",
      startedAt: Date.now() - Math.round(process.uptime() * 1000),
      uptimeSec: Math.round(process.uptime()),
    },
    memory: {
      rssMiB: mib(mem.rss),
      heapUsedMiB: mib(mem.heapUsed),
      heapTotalMiB: mib(mem.heapTotal),
      externalMiB: mib(mem.external),
      arrayBuffersMiB: mib(mem.arrayBuffers),
    },
    envKeys: Object.keys(process.env).sort(),
    routes: input.routeCount,
    plugins: input.plugins,
    stores: {
      tracesRetained: input.tracesRetained,
      logsRetained: input.logsRetained,
      activeRequests: input.activeRequests,
    },
    features: input.features,
  };
};
