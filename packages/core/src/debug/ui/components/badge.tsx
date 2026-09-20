/**
 * @fileoverview Badge + Chip primitives, plus the typed badge wrappers that map
 * domain values (HTTP method, status, span kind, log level, SQL action) onto the
 * shared tone system. Colors come from tokens only; `KindBadge` reads its
 * palette color through the existing `kindColor` helper. Status always carries
 * a text label, so it is never conveyed by color alone (spec §6.7).
 */

import type { JSX } from "solid-js";

import { kindColor, methodCls, sqlPillCls, statusCls } from "../format";

/** Semantic tone a badge can carry. */
export type BadgeTone = "ok" | "warn" | "err" | "info" | "neutral";

/** Fill style: soft tint (default) or solid. */
export type BadgeVariant = "solid" | "soft";

const BASE =
  "inline-flex h-5 items-center gap-1 rounded-sm border px-1.5 text-xs font-medium leading-none";

const SOFT: Record<BadgeTone, string> = {
  ok: "bg-ok-soft text-ok border-ok/35",
  warn: "bg-warn-soft text-warn border-warn/35",
  err: "bg-err-soft text-err border-err/35",
  info: "bg-info-soft text-info border-info/35",
  neutral: "bg-surface-2 text-muted border-line",
};

const SOLID: Record<BadgeTone, string> = {
  ok: "bg-ok text-bg border-ok",
  warn: "bg-warn text-bg border-warn",
  err: "bg-err text-bg border-err",
  info: "bg-info text-bg border-info",
  neutral: "bg-surface-3 text-ink border-line",
};

/** Mono, tabular-numeric label classes for data-typographic badges. */
const MONO = " font-mono tabular-nums";

/** Soft color-mixed tint around one palette color (kind/method badges). */
const tintStyle = (color: string): JSX.CSSProperties => ({
  color,
  "background-color": `color-mix(in srgb, ${color} 14%, transparent)`,
  "border-color": `color-mix(in srgb, ${color} 35%, transparent)`,
});

interface BadgeProps {
  /** Semantic tone. */
  tone: BadgeTone;
  /** Fill style; defaults to `soft`. */
  variant?: BadgeVariant | undefined;
  /** Render the label in the mono, tabular-numeric face. */
  mono?: boolean | undefined;
  /** Badge label. */
  children: JSX.Element;
}

/** Tone-driven status/label badge. */
export const Badge = (props: BadgeProps): JSX.Element => {
  const cls = (): string =>
    `${BASE} ${props.variant === "solid" ? SOLID[props.tone] : SOFT[props.tone]}${
      props.mono === true ? MONO : ""
    }`;
  return <span class={cls()}>{props.children}</span>;
};

interface ChipProps {
  /** Chip content. */
  children?: JSX.Element | undefined;
  /** Extra classes (e.g. an env tone). */
  class?: string | undefined;
  /** Native tooltip. */
  title?: string | undefined;
  /** Copy-on-click text; emitted as `data-copy` for the shell's delegated listener. */
  dataCopy?: string | undefined;
}

/** Small neutral chip. */
export const Chip = (props: ChipProps): JSX.Element => (
  <span
    class={`inline-flex h-5 items-center gap-1 rounded-sm border border-line bg-surface-2 px-1.5 text-xs text-muted${
      props.class !== undefined ? ` ${props.class}` : ""
    }`}
    title={props.title}
    data-copy={props.dataCopy}
  >
    {props.children}
  </span>
);

/** HTTP verb → categorical token (unlisted verbs fall back to cat-7 grey). */
const METHOD_COLOR: Record<string, string> = {
  get: "var(--cat-2)",
  post: "var(--cat-1)",
  put: "var(--cat-4)",
  patch: "var(--cat-6)",
  delete: "var(--cat-8)",
  head: "var(--cat-3)",
  options: "var(--cat-7)",
};

/** HTTP-method badge — seven-color categorical identity, mono. */
export const MethodBadge = (props: { method: string }): JSX.Element => {
  const color = (): string => METHOD_COLOR[methodCls(props.method)] ?? "var(--cat-7)";
  return (
    <span class={`${BASE}${MONO}`} style={tintStyle(color())}>
      {props.method}
    </span>
  );
};

/** Status-family → text label, so the badge is never color-only. */
const STATUS_LABEL: Record<string, string> = {
  ok: "OK",
  info: "Redirect",
  warn: "Client Error",
  err: "Server Error",
};

/** HTTP-status badge: numeric code + family label (never color-only). */
export const StatusBadge = (props: { status: number }): JSX.Element => {
  const tone = (): BadgeTone => statusCls(props.status) as BadgeTone;
  return (
    <Badge tone={tone()} mono>
      {`${props.status} ${STATUS_LABEL[tone()] ?? ""}`.trim()}
    </Badge>
  );
};

/** Span-kind badge, colored from the categorical palette via `kindColor`. */
export const KindBadge = (props: { kind: string }): JSX.Element => (
  <span class={BASE} style={tintStyle(kindColor(props.kind))}>
    {props.kind}
  </span>
);

/** Log level → tone (unlisted levels fall back to `neutral`). */
const LEVEL_TONE: Record<string, BadgeTone> = {
  debug: "neutral",
  info: "info",
  warn: "warn",
  error: "err",
  fatal: "err",
};

/** Log-level badge (mono, uppercased). */
export const LevelBadge = (props: { level: string }): JSX.Element => (
  <Badge tone={LEVEL_TONE[props.level.toLowerCase()] ?? "neutral"} mono>
    {props.level.toUpperCase()}
  </Badge>
);

/** SQL action family → tone (via the shared `sqlPillCls` helper). */
const SQL_TONE: Record<string, BadgeTone> = {
  select: "info",
  insert: "ok",
  update: "warn",
  delete: "err",
  other: "neutral",
};

/** SQL-action badge (`SELECT`/`INSERT`/`UPDATE`/`DELETE`/other). */
export const SqlBadge = (props: { action: string | null | undefined }): JSX.Element => (
  <Badge tone={SQL_TONE[sqlPillCls(props.action)] ?? "neutral"} mono>
    {String(props.action ?? "SQL").toUpperCase()}
  </Badge>
);
