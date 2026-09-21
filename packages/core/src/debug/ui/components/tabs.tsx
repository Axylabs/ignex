/**
 * @fileoverview ARIA tab strip primitive. `Tabs` owns only the `tablist`; the
 * view renders the matching panel with `id="tabpanel-<active>"` and
 * `role="tabpanel"` / `aria-labelledby="tab-<active>"` so deep links and screen
 * readers stay consistent. A roving `tabindex` keeps a single tab in the tab
 * order, and the arrow/Home/End keys move the selection (wrapping at the ends)
 * while focus follows the newly active tab (WAI-ARIA tabs pattern).
 */

import { For, type JSX } from "solid-js";

import { nextTabIndex, tabKeyTarget } from "./tabs-keys";

interface TabsProps {
  /** Tab definitions, in display order. */
  tabs: { id: string; label: string }[];
  /** Id of the active tab. */
  active: string;
  /** Called with the tab id on click or key-driven selection. */
  onSelect: (id: string) => void;
}

/** ARIA `tablist` of buttons wired to `tabpanel-<id>` panels. */
export const Tabs = (props: TabsProps): JSX.Element => {
  // One ref per tab, so a key-driven selection can move focus to the new tab.
  const refs: HTMLButtonElement[] = [];

  /** Arrow/Home/End navigation over the roving `tabindex`. */
  const onKeyDown = (ev: KeyboardEvent): void => {
    const current = Math.max(
      0,
      props.tabs.findIndex((tab) => tab.id === props.active),
    );
    const next = nextTabIndex(tabKeyTarget(ev.key), current, props.tabs.length);
    if (next === null || next === current) return;
    const tab = props.tabs[next];
    if (tab === undefined) return;
    ev.preventDefault();
    props.onSelect(tab.id);
    refs[next]?.focus();
  };

  return (
    <div role="tablist" class="flex items-center gap-1 border-b border-line" onKeyDown={onKeyDown}>
      <For each={props.tabs}>
        {(tab, index) => (
          <button
            ref={(el): void => {
              refs[index()] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${tab.id}`}
            aria-selected={props.active === tab.id}
            aria-controls={`tabpanel-${tab.id}`}
            tabindex={props.active === tab.id ? 0 : -1}
            class={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
              props.active === tab.id
                ? "border-accent text-ink"
                : "border-transparent text-muted hover:text-ink"
            }`}
            onClick={() => props.onSelect(tab.id)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
};
