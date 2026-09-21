/**
 * @fileoverview Context bar — the shell's single horizontal control strip
 * (replaces the old 15-button nav row). Holds the nav toggle, the
 * `service / View` breadcrumb, and the global live-tail / refresh / theme /
 * command-palette controls. Per-view actions live in each view's
 * `PageHeader`, never here.
 */

import type { JSX } from "solid-js";

import { Button } from "../components/button";
import { Icon } from "../components/icon";
import { paused, pushPulse, setPaused } from "../live";
import { getTheme, toggleTheme } from "../theme";

interface ContextBarProps {
  /** Service name shown at the head of the breadcrumb. */
  service: string;
  /** Active view's label (breadcrumb tail). */
  viewLabel: string;
  /**
   * Whether the viewport pins the sidebar mode (the 761–1100px rail band).
   * When true the nav toggle is disabled: there is no full/rail choice.
   */
  navForced: boolean;
  /** Toggle the sidebar (rail↔full, or the mobile drawer). */
  onToggleNav: () => void;
  /** Open the command palette. */
  onOpenPalette: () => void;
}

/** Sticky strip above the view outlet: nav toggle, breadcrumb, global actions. */
export const ContextBar = (props: ContextBarProps): JSX.Element => (
  <div class="sticky top-0 z-30 flex h-(--context-h) items-center gap-3 border-b border-line bg-surface-1/90 px-4 backdrop-blur">
    <Button
      variant="icon"
      icon="menu"
      title={props.navForced ? "Navigation is fixed at this width" : "Toggle navigation"}
      disabled={props.navForced}
      onClick={props.onToggleNav}
    />
    <nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-1.5 text-sm">
      <span class="truncate text-muted">{props.service}</span>
      <Icon name="chevron-right" size={12} class="shrink-0 text-faint" />
      <span class="truncate font-medium text-ink">{props.viewLabel}</span>
    </nav>
    <div class="ml-auto flex items-center gap-2">
      <Button
        variant="icon"
        icon={paused() ? "play" : "pause"}
        ariaPressed={paused()}
        title={paused() ? "Resume live tail" : "Pause live tail"}
        onClick={(): void => {
          setPaused(!paused());
        }}
      />
      <Button variant="icon" icon="refresh" title="Refresh (r)" onClick={(): void => pushPulse()} />
      <Button
        variant="icon"
        icon={getTheme() === "dark" ? "sun" : "moon"}
        title="Toggle theme (t)"
        onClick={(): void => toggleTheme()}
      />
      <Button
        variant="ghost"
        size="sm"
        icon="search"
        label="⌘K"
        title="Command palette (⌘K)"
        onClick={(): void => props.onOpenPalette()}
      />
    </div>
  </div>
);
