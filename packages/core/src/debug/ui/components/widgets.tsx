/**
 * @fileoverview Shared view widgets — panels, stat cards, pills, chips, bars,
 * empty states and key/value grids. All text goes through Solid's text
 * interpolation, so user data can never inject markup.
 */

import { For, type JSX } from "solid-js";

import { kindColor, methodCls, sqlPillCls, statusCls } from "../format";

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

/** Titled panel card wrapping body content. */
export const Panel = (props: PanelProps): JSX.Element => (
  <section class="panel">
    {props.title !== undefined || props.headExtra !== undefined || props.hint !== undefined ? (
      <div class="panel-head">
        {props.title !== undefined ? <h2>{props.title}</h2> : null}
        {props.headExtra}
        {props.hint !== undefined ? (
          <>
            <span class="grow" />
            {props.hint}
          </>
        ) : null}
      </div>
    ) : null}
    {props.children}
  </section>
);

/* ── stat cards ────────────────────────────────────────────────────────── */

interface StatCardProps {
  value: unknown;
  label: string;
  sub?: string | undefined;
  /** State tone (`err`, `warn`, `ok`, `accent`) for color coding. */
  tone?: string | undefined;
}

/** Stat card: big value + label (+ optional sub line + state tone). */
export const StatCard = (props: StatCardProps): JSX.Element => (
  <div class={`stat${props.tone ? ` ${props.tone}` : ""}`}>
    <div class="v">
      {props.value === null || props.value === undefined ? "—" : String(props.value)}
    </div>
    <div class="k">{props.label}</div>
    {props.sub !== undefined ? <div class="sub">{props.sub}</div> : null}
  </div>
);

/** Responsive row of stat cards. */
export const StatRow = (props: { children?: JSX.Element }): JSX.Element => (
  <div class="stats">{props.children}</div>
);

/* ── pills / chips ─────────────────────────────────────────────────────── */

/** HTTP method pill (color per verb). */
export const MethodPill = (props: { method: string }): JSX.Element => (
  <span class={`pill method ${methodCls(props.method)}`}>{props.method}</span>
);

/** Status pill (color per status family). */
export const StatusPill = (props: { status: number }): JSX.Element => (
  <span class={`pill status ${statusCls(props.status)}`}>{String(props.status)}</span>
);

/** Span-kind pill with its palette color. */
export const KindPill = (props: { kind: string }): JSX.Element => (
  <span class="pill kind" style={{ "--kc": kindColor(props.kind) }}>
    {props.kind}
  </span>
);

/** Log-level pill. */
export const LevelPill = (props: { level: string }): JSX.Element => (
  <span class={`lv-pill lv-${props.level}`}>{props.level}</span>
);

/** NATS direction pill. */
export const DirPill = (props: { direction: string }): JSX.Element =>
  props.direction === "out" ? (
    <span class="pill kind" style={{ "--kc": "var(--k-http)" }}>
      out
    </span>
  ) : (
    <span class="pill kind" style={{ "--kc": "var(--k-cache)" }}>
      in
    </span>
  );

/** SQL action pill. */
export const SqlPill = (props: { action: string | null | undefined }): JSX.Element => (
  <span class={`sql-pill sql-${sqlPillCls(props.action)}`}>
    {String(props.action ?? "SQL").toUpperCase()}
  </span>
);

/** Neutral count chip. */
export const CountChip = (props: { n: number | string }): JSX.Element => (
  <span class="count-pill">{String(props.n)}</span>
);

interface ChipProps {
  children?: JSX.Element;
  /** Extra classes (e.g. `mono`, env tones). */
  class?: string;
  title?: string;
  /** Copy-on-click text (handled by the shell's delegated listener). */
  dataCopy?: string;
}

/** Small neutral chip. */
export const Chip = (props: ChipProps): JSX.Element => (
  <span
    class={`chip${props.class ? ` ${props.class}` : ""}`}
    title={props.title}
    data-copy={props.dataCopy}
  >
    {props.children}
  </span>
);

/* ── empty state ───────────────────────────────────────────────────────── */

interface EmptyStateProps {
  glyph: string;
  message: string;
  hint?: string | undefined;
}

/** Empty-state block inside a panel. */
export const EmptyState = (props: EmptyStateProps): JSX.Element => (
  <div class="empty">
    <div class="big">{props.glyph}</div>
    {props.message}
    {props.hint !== undefined ? <div class="hint">{props.hint}</div> : null}
  </div>
);

/* ── bars ──────────────────────────────────────────────────────────────── */

/** Keyboard activation for clickable rows (Enter/Space → action). */
export const rowKeyHandler =
  (action: () => void) =>
  (ev: KeyboardEvent): void => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      action();
    }
  };

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

export interface KvsRow {
  k: string;
  v: string | JSX.Element;
  /** Render the value in the mono face. */
  mono?: boolean;
}

/** Key/value definition grid. */
export const Kvs = (props: { rows: KvsRow[] }): JSX.Element => (
  <div class="kvs">
    <For each={props.rows}>
      {(row): JSX.Element => (
        <div>
          <span class="k">{row.k}</span>
          <span class={row.mono === true ? "v mono" : "v"}>{row.v}</span>
        </div>
      )}
    </For>
  </div>
);

/** Header record → kvs rows. */
export const headerRows = (headers: Record<string, string>): KvsRow[] =>
  Object.keys(headers).map((key) => ({ k: key, v: headers[key] ?? "", mono: true }));
