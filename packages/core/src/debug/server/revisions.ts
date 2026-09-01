/**
 * @fileoverview Revision counters — the mutation signal source for the SSE
 * live stream. Every data domain (traces/logs/metrics/system/events) owns a
 * monotonically increasing counter; the stream endpoint compares epochs and
 * pushes a frame only when something actually changed. Cheap (one integer
 * increment per mutation) and dependency-free.
 */

/** Data domains with revision counters. */
export type RevisionDomain = "traces" | "logs" | "metrics" | "system" | "events";

const DOMAINS: readonly RevisionDomain[] = ["traces", "logs", "metrics", "system", "events"];

/** Wire frame pushed to connected dashboards. */
export interface RevisionFrame {
  epoch: number;
  traces: number;
  logs: number;
  metrics: number;
  system: number;
  events: number;
}

export interface RevisionCounters {
  /** Bump a domain after a mutation. */
  bump: (domain: RevisionDomain) => void;
  /** Current counters snapshot (also advances the epoch check cursor). */
  snapshot: () => RevisionFrame;
  /** True when any counter moved since `frame` was taken. */
  changedSince: (frame: RevisionFrame) => boolean;
}

/** Create the counter set for one debugbar instance. */
export const createRevisionCounters = (): RevisionCounters => {
  const counts = new Map<RevisionDomain, number>(DOMAINS.map((d) => [d, 0]));
  let epoch = 0;
  return {
    bump: (domain): void => {
      const current = counts.get(domain) ?? 0;
      counts.set(domain, current + 1);
      epoch++;
    },
    snapshot: (): RevisionFrame => ({
      epoch,
      traces: counts.get("traces") ?? 0,
      logs: counts.get("logs") ?? 0,
      metrics: counts.get("metrics") ?? 0,
      system: counts.get("system") ?? 0,
      events: counts.get("events") ?? 0,
    }),
    changedSince: (frame): boolean => DOMAINS.some((d) => (counts.get(d) ?? 0) !== frame[d]),
  };
};
