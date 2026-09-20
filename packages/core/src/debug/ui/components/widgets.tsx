/**
 * @fileoverview Bar helpers — `BarRow` + `BarTrack` are the only widgets left
 * without an owning module, so they live here. This file used to be the
 * transitional compatibility barrel that re-exported every primitive; it was
 * reduced to just these two once every view imported from the owning module
 * (the `Panel`/`StatCard`/pill/Kvs re-exports had no consumers left).
 * Utility-styled; no bespoke CSS classes.
 */

import type { JSX } from "solid-js";

/** Flex row holding a label and a proportion bar. */
export const BarRow = (props: { children?: JSX.Element }): JSX.Element => (
  <div class="flex items-center gap-2">{props.children}</div>
);

interface BarTrackProps {
  /** Fill width in percent (0–100). */
  pct: number;
  /** Optional CSS color override for the fill (defaults to the accent). */
  color?: string | undefined;
  /** Optional max-width cap for the track. */
  maxWidth?: string | undefined;
  title?: string | undefined;
}

/** Proportional bar track with a filled segment (utility-styled; no CSS classes). */
export const BarTrack = (props: BarTrackProps): JSX.Element => (
  <span
    class="h-1.5 min-w-10 flex-1 overflow-hidden rounded-full bg-surface-3"
    title={props.title}
    style={{ "max-width": props.maxWidth }}
  >
    <span
      class="block h-full rounded-full"
      style={{
        width: `${props.pct}%`,
        "background-color": props.color ?? "var(--accent)",
      }}
    />
  </span>
);
