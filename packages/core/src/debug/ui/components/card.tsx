/**
 * @fileoverview Card, CardGrid, Callout and Disclosure primitives — the
 * surface + disclosure skeleton every view composes from. Appearance comes
 * from Tailwind utilities bound to the design tokens; layout stays with the
 * caller. There is no margin on the card itself: vertical rhythm comes from a
 * page stack (`AppShell` main uses `flex flex-col gap-4`).
 */

import { type JSX, Show } from "solid-js";

import { Badge } from "./badge";
import { Icon, type IconName } from "./icon";

const CARD = "rounded-lg border border-line bg-surface-1";
const HEAD = "flex items-start gap-2";
const TITLE = "text-xs font-semibold uppercase tracking-wide text-muted";

interface CardProps {
  /** Uppercase card title (rendered as `<h2>`); omitted → no head row. */
  title?: string | undefined;
  /** Secondary line rendered under the title. */
  description?: string | undefined;
  /** Action slot, pushed to the right edge of the head row. */
  actions?: JSX.Element | undefined;
  /** Extra elements rendered next to the title (`Panel` compatibility). */
  headExtra?: JSX.Element | undefined;
  /** Right-aligned trailing element in the head row (`Panel` compatibility). */
  hint?: JSX.Element | undefined;
  /**
   * Body padding; defaults to `true` (`p-4`). Pass `false` when the card is a
   * bare surface and the caller owns all spacing (e.g. a table card whose
   * scroller must reach the card edges).
   */
  pad?: boolean | undefined;
  /** Card body. */
  children?: JSX.Element | undefined;
}

/**
 * Titled surface card. Renders a `rounded-lg` token surface with an optional
 * uppercase head (`title` / `description` / `headExtra` / `hint` / `actions`).
 */
export const Card = (props: CardProps): JSX.Element => {
  const hasHead = (): boolean =>
    props.title !== undefined ||
    props.description !== undefined ||
    props.actions !== undefined ||
    props.headExtra !== undefined ||
    props.hint !== undefined;
  const hasTrailing = (): boolean => props.hint !== undefined || props.actions !== undefined;
  const headClass = (): string => {
    // Unpadded cards own their body spacing, so the head carries its own
    // padding and a hairline separator instead of relying on the section's.
    if (props.pad === false) return `${HEAD} border-b border-line px-4 py-3`;
    return props.children !== undefined ? `${HEAD} mb-3` : HEAD;
  };
  return (
    <section class={props.pad === false ? CARD : `${CARD} p-4`}>
      <Show when={hasHead()}>
        <div class={headClass()}>
          <div class="min-w-0">
            <Show when={props.title !== undefined}>
              <h2 class={TITLE}>{props.title}</h2>
            </Show>
            <Show when={props.description !== undefined}>
              <p class="mt-1 text-sm text-muted">{props.description}</p>
            </Show>
          </div>
          {props.headExtra}
          <Show when={hasTrailing()}>
            <div class="ml-auto flex items-center gap-2">
              {props.hint}
              {props.actions}
            </div>
          </Show>
        </div>
      </Show>
      {props.children}
    </section>
  );
};

/**
 * Responsive card grid. Columns auto-fill at the caller's minimum track width;
 * the min is passed as a CSS custom property so the arbitrary Tailwind value
 * stays a single static class.
 */
export const CardGrid = (props: { min: number; children: JSX.Element }): JSX.Element => (
  <div
    class="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(var(--card-min),1fr))]"
    style={{ "--card-min": `${props.min}px` }}
  >
    {props.children}
  </div>
);

/** Semantic tone a callout can carry. */
export type CalloutTone = "ok" | "warn" | "err" | "info";

const CALLOUT_TONE: Record<CalloutTone, string> = {
  ok: "border-ok/35 bg-ok-soft text-ok",
  warn: "border-warn/35 bg-warn-soft text-warn",
  err: "border-err/35 bg-err-soft text-err",
  info: "border-info/35 bg-info-soft text-info",
};

const CALLOUT_ICON: Record<CalloutTone, IconName> = {
  ok: "check",
  warn: "alert",
  err: "x-circle",
  info: "info",
};

interface CalloutProps {
  /** Semantic tone driving border, tint and default icon. */
  tone: CalloutTone;
  /** Bold callout headline. */
  title: string;
  /** Icon override; defaults to the tone's icon. */
  icon?: IconName | undefined;
  /** Callout body. */
  children?: JSX.Element | undefined;
}

/**
 * Tone-coloured advisory banner — replaces the old `.verdict` / `.kt-callout`
 * / `.f-reco` one-offs.
 */
export const Callout = (props: CalloutProps): JSX.Element => (
  <div class={`flex gap-2.5 rounded-lg border px-4 py-3 ${CALLOUT_TONE[props.tone]}`}>
    <Icon name={props.icon ?? CALLOUT_ICON[props.tone]} class="mt-0.5 shrink-0" />
    <div class="min-w-0">
      <div class="text-sm font-medium text-ink">{props.title}</div>
      <Show when={props.children !== undefined}>
        <div class="mt-0.5 text-sm text-muted">{props.children}</div>
      </Show>
    </div>
  </div>
);

interface DisclosureProps {
  /** Always-visible summary label. */
  summary: string;
  /** Optional count rendered as a neutral badge next to the summary. */
  count?: number | undefined;
  /** Collapsed content. */
  children: JSX.Element;
}

/**
 * Native `<details>` disclosure styled with utilities only — the chevron is an
 * `Icon` rotated by the `group-open` variant, so it needs no bespoke CSS.
 */
export const Disclosure = (props: DisclosureProps): JSX.Element => (
  <details class="group rounded-lg border border-line bg-surface-1">
    <summary class="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 text-sm text-ink [&::-webkit-details-marker]:hidden">
      <Icon
        name="chevron-right"
        class="shrink-0 text-faint transition-transform group-open:rotate-90"
      />
      <span>{props.summary}</span>
      <Show when={props.count !== undefined}>
        <Badge tone="neutral" mono>
          {String(props.count)}
        </Badge>
      </Show>
    </summary>
    <div class="border-t border-line px-4 py-3">{props.children}</div>
  </details>
);
