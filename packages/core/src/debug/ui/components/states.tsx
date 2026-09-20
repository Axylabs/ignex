/**
 * @fileoverview Empty / loading / error state primitives — the three non-data
 * renders every view needs. All are token-styled and accessible
 * (`role="status"` for loading, `role="alert"` for errors).
 */

import { For, type JSX, Show } from "solid-js";

import { Button } from "./button";
import { Icon, type IconName } from "./icon";

interface EmptyStateProps {
  /** Legacy emoji/glyph marker (kept for unmigrated views). */
  glyph?: string | undefined;
  /** Inline-SVG marker; preferred over `glyph`. */
  icon?: IconName | undefined;
  /** Required empty message. */
  message: string;
  /** Optional secondary hint. */
  hint?: string | undefined;
}

/** Centered empty-state block for a panel or table body. */
export const EmptyState = (props: EmptyStateProps): JSX.Element => (
  <div class="flex flex-col items-center justify-center gap-2 py-10 text-center text-sm text-muted">
    {props.glyph !== undefined ? (
      <div class="text-xl text-faint">{props.glyph}</div>
    ) : props.icon !== undefined ? (
      <Icon name={props.icon} size={24} class="text-faint" />
    ) : null}
    <div class="text-ink">{props.message}</div>
    {props.hint !== undefined ? (
      <div class="max-w-[52ch] text-xs text-faint">{props.hint}</div>
    ) : null}
  </div>
);

interface LoadingStateProps {
  /** Number of skeleton rows; defaults to `3`. */
  rows?: number | undefined;
}

/** Pulsing skeleton rows shown while the first fetch is in flight. */
export const LoadingState = (props: LoadingStateProps): JSX.Element => {
  const count = (): number => Math.max(1, props.rows ?? 3);
  return (
    <div class="flex flex-col gap-2 p-4" role="status" aria-busy="true">
      <span class="sr-only">Loading…</span>
      <For each={Array.from({ length: count() })}>
        {() => <div class="h-5 animate-pulse rounded-sm bg-surface-3" />}
      </For>
    </div>
  );
};

interface ErrorStateProps {
  /** Primary error message. */
  message: string;
  /** Optional secondary hint (e.g. what to try). */
  hint?: string | undefined;
  /** Optional retry action. */
  onRetry?: (() => void) | undefined;
}

/** Inline error panel with an optional retry button. */
export const ErrorState = (props: ErrorStateProps): JSX.Element => (
  <div
    role="alert"
    class="flex flex-col items-center gap-2 rounded-lg border border-err/35 bg-err-soft px-4 py-6 text-center"
  >
    <Icon name="alert" size={24} class="text-err" />
    <div class="text-sm text-ink">{props.message}</div>
    <Show when={props.hint !== undefined}>
      <div class="max-w-[52ch] text-xs text-muted">{props.hint}</div>
    </Show>
    <Show when={props.onRetry !== undefined}>
      <Button variant="ghost" icon="refresh" label="Retry" onClick={() => props.onRetry?.()} />
    </Show>
  </div>
);
