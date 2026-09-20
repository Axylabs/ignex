/**
 * @fileoverview Button primitive — the single button surface for the dashboard.
 *
 * Composed from Tailwind utilities bound to the design tokens; appearance lives
 * in this component, layout stays with the caller. The primary variant uses a
 * locally derived solid fill (see `PRIMARY_FILL`) because `--accent-fg` on
 * `--accent` is only ~2.8:1 and would ship an illegible label.
 */

import type { JSX } from "solid-js";

import { Icon, type IconName } from "./icon";

/** Visual variants a button can take. */
export type ButtonVariant = "primary" | "ghost" | "danger" | "icon";

/** Button sizes; the `icon` variant is a fixed square regardless of size. */
export type ButtonSize = "sm" | "md";

/**
 * Solid-fill background for the primary variant.
 *
 * `--accent` (#4d9cff, dark theme) with `--accent-fg` (#ffffff) is only ~2.8:1.
 * Mixing 70% accent with 30% black yields white text ~5.3:1 in the dark theme
 * and ~7.9:1 against the light theme's `--accent` (#1f6feb) — both above the
 * 4.5:1 floor. `--accent` remains the interactive border/ring/link token; only
 * this solid fill differs, and it stays theme-aware through `color-mix`.
 */
const PRIMARY_FILL = "color-mix(in srgb, var(--accent) 70%, #000)";

const BASE =
  "inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors disabled:cursor-default disabled:opacity-55 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2",
  md: "h-8 px-3",
};

const VARIANT: Record<ButtonVariant, string> = {
  primary: "text-accent-fg hover:brightness-110",
  ghost: "border border-line text-muted hover:bg-surface-2 hover:text-ink hover:border-line-strong",
  danger: "border border-line text-err hover:bg-err-soft hover:border-err",
  icon: "h-7 w-7 border border-line text-muted hover:bg-surface-2 hover:text-ink",
};

interface ButtonProps {
  /** Visual variant; defaults to `ghost`. */
  variant?: ButtonVariant | undefined;
  /** Height/padding; ignored by the `icon` variant. Defaults to `md`. */
  size?: ButtonSize | undefined;
  /** Optional leading icon. */
  icon?: IconName | undefined;
  /** Text label rendered after the icon. */
  label?: string | undefined;
  /** Disables the button (native attribute + styling). */
  disabled?: boolean | undefined;
  /** Native tooltip / accessible name for icon-only buttons. */
  title?: string | undefined;
  /** Click handler. */
  onClick?: ((ev: MouseEvent) => void) | undefined;
  /** Copy-on-click text; emitted as `data-copy` for the shell's delegated listener. */
  dataCopy?: string | undefined;
  /** Extra content rendered after the label. */
  children?: JSX.Element | undefined;
}

/** Button primitive — primary / ghost / danger / icon. */
export const Button = (props: ButtonProps): JSX.Element => {
  const variant = (): ButtonVariant => props.variant ?? "ghost";
  const cls = (): string => {
    const v = variant();
    if (v === "icon") return `${BASE} ${VARIANT.icon}`;
    return `${BASE} ${SIZE[props.size ?? "md"]} ${VARIANT[v]}`;
  };
  return (
    <button
      type="button"
      class={cls()}
      style={variant() === "primary" ? { "background-color": PRIMARY_FILL } : undefined}
      disabled={props.disabled}
      title={props.title}
      data-copy={props.dataCopy}
      onClick={(ev) => props.onClick?.(ev)}
    >
      {props.icon !== undefined ? <Icon name={props.icon} /> : null}
      {props.label}
      {props.children}
    </button>
  );
};
