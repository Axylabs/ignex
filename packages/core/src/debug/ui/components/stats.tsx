/**
 * @fileoverview Stat primitives — the numeric-tile row/grid used by every
 * dashboard view. The value carries the data typography (mono, tabular) and a
 * tone colours only the value; there is no decorative halo.
 */

import type { JSX } from "solid-js";

/** Tone a stat value can take. */
export type StatTone = "ok" | "warn" | "err" | "accent";

const TONE: Record<StatTone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  err: "text-err",
  accent: "text-accent",
};

interface StatProps {
  /** The value; `null`/`undefined` render as an em dash. */
  value: unknown;
  /** Uppercase caption under the value. */
  label: string;
  /** Optional secondary line. */
  sub?: string | undefined;
  /** Colours the value only (never the tile). */
  tone?: StatTone | undefined;
}

/** Numeric tile: big mono value + uppercase label (+ optional sub line). */
export const Stat = (props: StatProps): JSX.Element => (
  <div class="rounded-lg border border-line bg-surface-1 px-3.5 py-3">
    <div
      class={`font-mono text-xl font-semibold tabular-nums ${
        props.tone !== undefined ? TONE[props.tone] : "text-ink"
      }`}
    >
      {props.value === null || props.value === undefined ? "—" : String(props.value)}
    </div>
    <div class="mt-0.5 text-xs uppercase tracking-wide text-muted">{props.label}</div>
    {props.sub !== undefined ? <div class="mt-0.5 text-xs text-faint">{props.sub}</div> : null}
  </div>
);

/** Responsive row of stats — tracks stretch to fill the available width. */
export const StatRow = (props: { children?: JSX.Element | undefined }): JSX.Element => (
  <div class="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
    {props.children}
  </div>
);

/** Dense auto-fill stat grid for dashboards with many tiles. */
export const StatGrid = (props: { children: JSX.Element }): JSX.Element => (
  <div class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(170px,1fr))]">
    {props.children}
  </div>
);
