/**
 * @fileoverview SystemProfiler — periodic CPU / memory / event-loop sampling.
 *
 * Samples process.cpuUsage (deltas), process.memoryUsage (RSS + heap) and the
 * event-loop delay via a staggered setTimeout. Runs on an unref'd interval so
 * it never keeps the process alive, and only while `started`. `activeRequests`
 * is injected by the plugin (the count of un-finalized traces).
 */

import type { SystemSample, SystemStats } from "./types";

/** Options for {@link SystemProfiler}. */
export interface SystemProfilerOptions {
  /** Sampling interval in ms. Default 1000; `0` disables sampling. */
  readonly sampleMs?: number;
  /** Maximum number of samples retained. Default 3600 (1h @1s). */
  readonly maxSamples?: number;
}

const mb = (bytes: number): number => Math.round((bytes / 1024 / 1024) * 10) / 10;

/**
 * Periodic sampler of process CPU / RSS / heap and event-loop delay. Runs on
 * an unref'd interval; see {@link SystemProfiler.start}.
 */
export class SystemProfiler {
  readonly sampleMs: number;
  private readonly maxSamples: number;
  private readonly samples: SystemSample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastCpu: NodeJS.CpuUsage = { user: 0, system: 0 };
  private lastSampleAt = performance.now();
  private _startedAt = 0;
  private activeRequests = 0;

  constructor(options: SystemProfilerOptions = {}) {
    this.sampleMs = options.sampleMs ?? 1000;
    this.maxSamples = options.maxSamples ?? 3600;
  }

  /** Begin sampling (idempotent; unref'd interval). */
  start(): void {
    if (this.timer || this.sampleMs <= 0) return;
    this._startedAt = Date.now();
    this.lastCpu = process.cpuUsage();
    this.lastSampleAt = performance.now();
    this.sample();
    this.timer = setInterval(() => this.sample(), this.sampleMs);
    this.timer.unref?.();
  }

  /** Stop sampling (idempotent). */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Update the in-flight request count (called by the plugin on finalize). */
  setActiveRequests(count: number): void {
    this.activeRequests = count;
  }

  private sample(): void {
    const now = performance.now();
    const cpu = process.cpuUsage();
    const dtMs = Math.max(1, now - this.lastSampleAt);
    const cpuMs = (cpu.user - this.lastCpu.user + (cpu.system - this.lastCpu.system)) / 1000;
    this.lastCpu = cpu;
    this.lastSampleAt = now;
    const mem = process.memoryUsage();
    this.samples.push({
      ts: now,
      cpuPct: Math.round((cpuMs / dtMs) * 1000 * 10) / 10,
      rssMiB: mb(mem.rss),
      heapMiB: mb(mem.heapUsed),
      eventLoopDelayMs: 0,
      activeRequests: this.activeRequests,
    });
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  /** Record an event-loop delay measurement (called from the plugin's timer). */
  recordEventLoopDelay(delayMs: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last) {
      (last as { eventLoopDelayMs: number }).eventLoopDelayMs = Math.round(delayMs * 10) / 10;
    }
  }

  get sampling(): boolean {
    return this.timer !== null;
  }

  get startedAt(): number {
    return this._startedAt;
  }

  /** Snapshot for the dashboard. */
  stats(requestTotals?: {
    requests: number;
    errors: number;
    avgMs: number;
    p95Ms: number;
  }): SystemStats {
    return {
      sampling: this.sampling,
      sampleMs: this.sampleMs,
      samples: [...this.samples],
      startedAt: this._startedAt,
      uptimeSec: this._startedAt ? Math.round((Date.now() - this._startedAt) / 1000) : 0,
      totals: {
        requests: requestTotals?.requests ?? 0,
        errors: requestTotals?.errors ?? 0,
        avgDurationMs: requestTotals?.avgMs ?? 0,
        p95DurationMs: requestTotals?.p95Ms ?? 0,
      },
    };
  }
}

/** Measure one event-loop delay round-trip and report it to the profiler. */
export const scheduleEventLoopProbe = (profiler: SystemProfiler): void => {
  const t0 = performance.now();
  const timer = setTimeout(() => {
    const delay = performance.now() - t0;
    profiler.recordEventLoopDelay(delay);
  }, 100);
  timer.unref?.();
};
