/**
 * @fileoverview Grouped sidebar navigation — the shell's primary nav. Renders
 * `NAV_GROUPS` into four labelled sections of icon + label links, highlights the
 * active route with `aria-current="page"`, and shows an optional live badge
 * (the error count) on Errors. Presentation is driven by {@link NavMode}:
 * a 220px panel on wide screens, a 56px icon rail at ≤1100px, and an off-canvas
 * drawer at ≤760px. The desktop preference is persisted in localStorage.
 */

import { createMemo, createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";

import { Chip } from "../components/badge";
import { Icon } from "../components/icon";
import { iconForView, NAV_GROUPS } from "../nav";
import { currentRoute } from "../router";
import type { ViewDef } from "../views/registry";
import { liveErrorCount } from "../views/requests";

/** localStorage key holding the desktop nav preference (`full` | `rail`). */
const NAV_KEY = "ignex-debugbar-nav";

/** Viewport width at/below which the sidebar becomes an icon rail. */
const RAIL_MAX = 1100;

/** Viewport width at/below which the sidebar becomes an off-canvas drawer. */
const DRAWER_MAX = 760;

/** How the sidebar is presented at the current viewport. */
export type NavMode = "full" | "rail" | "drawer";

/** Sidebar state the shell reads and controls. */
export interface NavState {
  /** Effective mode after viewport + persisted preference. */
  mode: () => NavMode;
  /** Whether the off-canvas drawer is open (drawer mode only). */
  drawerOpen: () => boolean;
  /** Toggle rail↔full on desktop, or the drawer on narrow screens. */
  toggle: () => void;
  /** Close the drawer (nav activation / scrim click). */
  close: () => void;
}

/** Current viewport width, defaulting to the wide (full) layout without a DOM. */
const viewportWidth = (): number => {
  try {
    return window.innerWidth;
  } catch {
    return RAIL_MAX + 1;
  }
};

/** Read the persisted desktop preference, tolerating unavailable storage. */
const readNavPref = (): "full" | "rail" => {
  try {
    return localStorage.getItem(NAV_KEY) === "rail" ? "rail" : "full";
  } catch {
    return "full";
  }
};

/**
 * Build the sidebar's reactive state: the persisted desktop preference, the
 * transient drawer flag, and the viewport-derived effective mode. Registers a
 * single resize listener (torn down with the owning component).
 */
export const createNavState = (): NavState => {
  const [pref, setPref] = createSignal<"full" | "rail">(readNavPref());
  const [drawerOpen, setDrawerOpen] = createSignal(false);
  const [width, setWidth] = createSignal(viewportWidth());

  onMount((): void => {
    const onResize = (): void => {
      setWidth(viewportWidth());
    };
    window.addEventListener("resize", onResize);
    onCleanup((): void => window.removeEventListener("resize", onResize));
  });

  const mode = createMemo<NavMode>(
    (): NavMode => (width() <= DRAWER_MAX ? "drawer" : width() <= RAIL_MAX ? "rail" : pref()),
  );

  const toggle = (): void => {
    if (mode() === "drawer") {
      setDrawerOpen((open) => !open);
      return;
    }
    const next = pref() === "rail" ? "full" : "rail";
    setPref(next);
    try {
      localStorage.setItem(NAV_KEY, next);
    } catch {
      /* private mode etc. — in-memory only */
    }
  };

  return {
    mode,
    drawerOpen,
    toggle,
    close: (): void => {
      setDrawerOpen(false);
    },
  };
};

interface NavItemProps {
  /** The view this entry links to. */
  view: ViewDef;
  /** Whether the entry is the active route. */
  active: boolean;
  /** Render icon-only with a tooltip. */
  rail: boolean;
  /** Optional live count; hidden when `undefined`/`0`. */
  badge?: number | undefined;
  /** Called after activation (closes the mobile drawer). */
  onNavigate: () => void;
}

/** One sidebar link: icon + label + optional live badge, active-aware. */
export const NavItem = (props: NavItemProps): JSX.Element => {
  const cls = (): string => {
    const base =
      "flex h-8 items-center gap-2.5 rounded-md px-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2";
    const layout = props.rail ? "justify-center" : "";
    const state = props.active
      ? "bg-accent-soft font-medium text-accent"
      : "text-muted hover:bg-surface-2 hover:text-ink";
    return `${base} ${layout} ${state}`;
  };
  return (
    <li>
      <a
        href={`#/${props.view.id}`}
        aria-current={props.active ? "page" : undefined}
        aria-label={props.rail ? props.view.label : undefined}
        title={props.rail ? props.view.label : undefined}
        class={cls()}
        onClick={(): void => props.onNavigate()}
      >
        <Icon name={iconForView(props.view.id)} size={16} class="shrink-0" />
        <span class={props.rail ? "sr-only" : "truncate"}>{props.view.label}</span>
        <Show when={props.badge !== undefined && props.badge > 0}>
          <span class="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-sm bg-err-soft px-1 font-mono text-xs tabular-nums text-err">
            {props.badge}
          </span>
        </Show>
      </a>
    </li>
  );
};

interface SidebarProps {
  /** Effective presentation mode. */
  mode: NavMode;
  /** Whether the off-canvas drawer is open (`drawer` mode only). */
  drawerOpen: boolean;
  /** `service@version` label shown under the brand title. */
  envLabel: string;
  /** Environment chip label (hidden when empty). */
  env: string;
  /** Called after any nav activation. */
  onNavigate: () => void;
}

/** The grouped, collapsible sidebar. */
export const Sidebar = (props: SidebarProps): JSX.Element => {
  const rail = (): boolean => props.mode === "rail";
  const isDrawer = (): boolean => props.mode === "drawer";
  const hidden = (): boolean => isDrawer() && !props.drawerOpen;

  const cls = (): string => {
    const base = "flex h-dvh shrink-0 flex-col border-r border-line bg-surface-1";
    if (isDrawer()) {
      const slide = hidden() ? "-translate-x-full" : "translate-x-0";
      return `${base} fixed inset-y-0 left-0 z-50 w-(--sidebar-w) transition-transform ${slide}`;
    }
    const width = rail() ? "w-(--sidebar-w-rail)" : "w-(--sidebar-w)";
    return `${base} sticky top-0 ${width} transition-[width]`;
  };

  // Detail routes keep their parent list highlighted (Errors is a Requests view).
  const activeId = createMemo<string>((): string => {
    const view = currentRoute().view;
    if (view === "detail") return "requests";
    if (view === "logDetail") return "logs";
    return view;
  });

  return (
    <aside class={cls()} inert={hidden() || undefined}>
      <div class="flex h-(--context-h) items-center gap-2.5 border-b border-line px-3">
        <span class="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent text-accent-fg">
          <Icon name="bolt" size={18} />
        </span>
        <div class={rail() ? "hidden" : "min-w-0"}>
          <div class="truncate text-sm font-bold tracking-tight text-ink">IgnEx Debugbar</div>
          <div class="mt-0.5 flex items-center gap-1.5">
            <span class="truncate font-mono text-xs text-faint">{props.envLabel}</span>
            <Show when={props.env !== ""}>
              <Chip class="font-mono">{props.env}</Chip>
            </Show>
          </div>
        </div>
      </div>

      <nav aria-label="Debugbar sections" class="flex-1 overflow-y-auto px-2 py-2">
        <For each={NAV_GROUPS}>
          {(group): JSX.Element => (
            // biome-ignore lint/a11y/useSemanticElements: a labelled nav section of links, not a form fieldset
            <div role="group" class="mb-3 last:mb-0">
              <h2
                class={`px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-faint ${
                  rail() ? "sr-only" : ""
                }`}
              >
                {group.label}
              </h2>
              <ul class="flex flex-col gap-0.5">
                <For each={group.items}>
                  {(view): JSX.Element => (
                    <NavItem
                      view={view}
                      active={activeId() === view.id}
                      rail={rail()}
                      badge={view.id === "errors" ? liveErrorCount() : undefined}
                      onNavigate={props.onNavigate}
                    />
                  )}
                </For>
              </ul>
            </div>
          )}
        </For>
      </nav>
    </aside>
  );
};
