/**
 * @fileoverview Compatibility barrel for the view widgets that predate the
 * primitives split. Every name views import from `./widgets` keeps its OLD
 * prop signature and delegates to the owning module; the two local pills
 * (`DirPill`, `CountChip`) and the two bar helpers are kept here because they
 * have no owning module yet. T25 deletes this barrel once every view imports
 * from the owning module.
 */

import type { JSX } from "solid-js";

import { MethodBadge, Chip as PrimitiveChip } from "./badge";
import { Card } from "./card";
import { Kvs as PrimitiveKvs } from "./kvs";
import { Stat, type StatTone } from "./stats";

/* ── panel ─────────────────────────────────────────────────────────────── */

interface PanelProps {
  /** Uppercase panel title (rendered as `<h2>`); omitted → no head row. */
  title?: string | undefined;
  /** Extra elements after the title inside the head row. */
  headExtra?: JSX.Element | undefined;
  /** Right-aligned trailing element inside the head row. */
  hint?: JSX.Element | undefined;
  children?: JSX.Element | undefined;
}

/** Titled panel card wrapping body content (delegates to `Card`). */
export const Panel = (props: PanelProps): JSX.Element => (
  <Card title={props.title} headExtra={props.headExtra} hint={props.hint}>
    {props.children}
  </Card>
);

/* ── stat cards ────────────────────────────────────────────────────────── */

interface StatCardProps {
  value: unknown;
  label: string;
  sub?: string | undefined;
  /** State tone (`err`, `warn`, `ok`, `accent`) for color coding. */
  tone?: string | undefined;
}

/** The tones the primitive `Stat` understands. */
const STAT_TONES: readonly string[] = ["ok", "warn", "err", "accent"];

/** Narrow the legacy free-form tone string to the primitive's tone union. */
const statTone = (tone: string | undefined): StatTone | undefined =>
  tone !== undefined && STAT_TONES.includes(tone) ? (tone as StatTone) : undefined;

/** Stat card: big value + label (+ optional sub line + state tone). */
export const StatCard = (props: StatCardProps): JSX.Element => (
  <Stat value={props.value} label={props.label} sub={props.sub} tone={statTone(props.tone)} />
);

export { StatRow } from "./stats";

/* ── pills / chips ─────────────────────────────────────────────────────── */

/** HTTP method pill (delegates to `MethodBadge`). */
export const MethodPill = MethodBadge;

/** Kind / level / SQL / status pills (re-exported from `badge`). */
export {
  KindBadge as KindPill,
  LevelBadge as LevelPill,
  SqlBadge as SqlPill,
  StatusBadge as StatusPill,
} from "./badge";

/** Small neutral chip (delegates to the primitive `Chip`). */
export const Chip = PrimitiveChip;

/** Shared pill box classes for the two local categorical pills. */
const PILL =
  "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium leading-none";

/** Soft color-mixed tint around one categorical palette color. */
const tintStyle = (color: string): JSX.CSSProperties => ({
  color,
  "background-color": `color-mix(in srgb, ${color} 14%, transparent)`,
  "border-color": `color-mix(in srgb, ${color} 35%, transparent)`,
});

/** NATS direction pill (`out` cat-3, `in` cat-2). */
export const DirPill = (props: { direction: string }): JSX.Element =>
  props.direction === "out" ? (
    <span class={PILL} style={tintStyle("var(--cat-3)")}>
      out
    </span>
  ) : (
    <span class={PILL} style={tintStyle("var(--cat-2)")}>
      in
    </span>
  );

/** Neutral count chip. */
export const CountChip = (props: { n: number | string }): JSX.Element => (
  <span class="inline-flex h-5 min-w-5 items-center justify-center rounded-sm border border-line bg-surface-2 px-1.5 font-mono text-xs tabular-nums text-muted">
    {String(props.n)}
  </span>
);

/* ── empty state ───────────────────────────────────────────────────────── */

export { EmptyState } from "./states";

/* ── bars ──────────────────────────────────────────────────────────────── */

export { rowKeyHandler } from "./table";

/** Flex row holding a label and a proportion bar. */
export const BarRow = (props: { children?: JSX.Element }): JSX.Element => (
  <div class="bar-row">{props.children}</div>
);

interface BarTrackProps {
  /** Fill width in percent (0–100). */
  pct: number;
  /** Optional CSS color override for the fill. */
  color?: string | undefined;
  /** Optional max-width cap for the track. */
  maxWidth?: string | undefined;
  title?: string | undefined;
}

/** Proportional bar track with a filled segment. */
export const BarTrack = (props: BarTrackProps): JSX.Element => (
  <span
    class="bar-track"
    title={props.title}
    style={{ "max-width": props.maxWidth, "--bar-color": props.color }}
  >
    <span class="bar-fill" style={{ width: `${props.pct}%` }} />
  </span>
);

/* ── key/value grid ────────────────────────────────────────────────────── */

export type { KvsRow } from "./kvs";

/** Key/value definition grid (delegates to the `kvs` module). */
export const Kvs = PrimitiveKvs;

export { headerRows } from "./kvs";
