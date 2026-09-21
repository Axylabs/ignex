/**
 * @fileoverview Page-header and toolbar primitives — the top of every view.
 * `PageHeader` owns the single `<h1>` per view (the guard in T26 asserts every
 * view has one); `Toolbar` is the filter/action strip that can stick under the
 * shell's context bar.
 */

import type { JSX } from "solid-js";

import { Button } from "./button";

interface PageHeaderProps {
  /** View title; rendered as the view's `<h1>`. */
  title: string;
  /** Optional supporting line under the title. */
  description?: string | undefined;
  /** Action buttons, pushed to the right edge. */
  actions?: JSX.Element | undefined;
  /** Optional back handler; renders an icon button when present. */
  back?: (() => void) | undefined;
  /** Optional badge rendered next to the title. */
  badge?: JSX.Element | undefined;
}

/** The one header every view renders: back + `<h1>` + description + actions. */
export const PageHeader = (props: PageHeaderProps): JSX.Element => (
  <header class="mb-4 flex items-start gap-3">
    {props.back !== undefined ? (
      <Button variant="icon" icon="chevron-left" title="Back" onClick={props.back} />
    ) : null}
    <div class="min-w-0">
      <div class="flex items-center gap-2">
        <h1 class="text-xl font-semibold tracking-tight text-ink">{props.title}</h1>
        {props.badge}
      </div>
      {props.description !== undefined ? (
        <p class="mt-0.5 text-sm text-muted">{props.description}</p>
      ) : null}
    </div>
    {props.actions !== undefined ? (
      <div class="ml-auto flex shrink-0 items-center gap-2">{props.actions}</div>
    ) : null}
  </header>
);

interface ToolbarProps {
  /** Filter/action controls. */
  children: JSX.Element;
  /** Stick under the shell's context bar while the view scrolls. */
  sticky?: boolean | undefined;
}

/** Filter/action strip above a table or card grid. */
export const Toolbar = (props: ToolbarProps): JSX.Element => (
  <div
    class={
      props.sticky === true
        ? "sticky top-(--context-h) -mx-2 mb-3 flex flex-wrap items-center gap-2 rounded-md bg-bg/85 px-2 py-2 backdrop-blur"
        : "mb-3 flex flex-wrap items-center gap-2"
    }
  >
    {props.children}
  </div>
);
