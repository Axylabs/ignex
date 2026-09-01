/**
 * @fileoverview Live-data bus shared by all views.
 *
 * The server pushes revision counters over the SSE stream (`/api/stream`);
 * every bump lands here as a `pulse`. Views declare which domain they care
 * about and refetch only when that domain's counter moved — so a log line
 * arriving never re-fetches the metrics view, and vice versa. When the stream
 * is unavailable, a slow fallback ticker bumps the same signal so behavior
 * degrades to the old polling model transparently. Manual refresh (`r`) bumps
 * every domain at once.
 */

import { batch, createSignal } from "solid-js";

import type { StreamRevision } from "./api";

/** Data domains the server revises (mirrors StreamRevision keys). */
export type Domain = "traces" | "logs" | "metrics" | "system" | "events";

const EMPTY_REVISION: StreamRevision = {
  epoch: 0,
  traces: 0,
  logs: 0,
  metrics: 0,
  system: 0,
  events: 0,
};

const [pulse, setPulse] = createSignal<{
  /** Monotonic tick (changes on every bump). */
  n: number;
  /** Revision payload when the bump came from the stream; null = refetch all. */
  rev: StreamRevision | null;
}>({ n: 0, rev: null });

/** True when live tailing is paused (⏸ button / live-dot). */
export const [paused, setPaused] = createSignal(false);

// Transport health is tracked by the shell locally; kept as a hook point for
// a future reconnect indicator.
export const [, setStreamUp] = createSignal(false);

let ticks = 0;

/** Bump views: pass a stream revision (domain-scoped) or nothing (full). */
export const pushPulse = (rev?: StreamRevision): void => {
  if (paused() && rev !== undefined && rev !== null) return; // tail frozen
  ticks++;
  setPulse({ n: ticks, rev: rev ?? null });
};

/** Current pulse value (reactive). */
export const currentPulse = pulse;

/**
 * Did `domain` move between two pulse reads? Used inside view effects to
 * ignore unrelated bumps (and the initial pulse).
 */
export const domainMoved = (
  prev: Map<Domain, number>,
  domain: Domain,
  rev: StreamRevision | null,
): boolean => {
  if (rev === null) return true; // full refresh request
  const next = rev[domain];
  const before = prev.get(domain);
  prev.set(domain, next);
  return before !== undefined && before !== next;
};

/** Seed the per-view baseline map with the latest known counters. */
export const baselineFrom = (rev: StreamRevision | null): Map<Domain, number> => {
  const source = rev ?? EMPTY_REVISION;
  return new Map<Domain, number>([
    ["traces", source.traces],
    ["logs", source.logs],
    ["metrics", source.metrics],
    ["system", source.system],
    ["events", source.events],
  ]);
};

/** Ingest one server revision frame (no-op counters are ignored upstream). */
export const ingestRevision = (rev: StreamRevision): void => {
  batch((): void => {
    pushPulse(rev);
  });
};

/** Latest known revision (for baselines). */
export const [lastRevision, setLastRevision] = createSignal<StreamRevision>(EMPTY_REVISION);
