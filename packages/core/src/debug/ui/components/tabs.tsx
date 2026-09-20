/**
 * @fileoverview ARIA tab strip primitive. `Tabs` owns only the `tablist`; the
 * view renders the matching panel with `id="tabpanel-<active>"` and
 * `role="tabpanel"` / `aria-labelledby="tab-<active>"` so deep links and screen
 * readers stay consistent.
 */

import { For, type JSX } from "solid-js";

interface TabsProps {
  /** Tab definitions, in display order. */
  tabs: { id: string; label: string }[];
  /** Id of the active tab. */
  active: string;
  /** Called with the tab id on click. */
  onSelect: (id: string) => void;
}

/** ARIA `tablist` of buttons wired to `tabpanel-<id>` panels. */
export const Tabs = (props: TabsProps): JSX.Element => (
  <div role="tablist" class="flex items-center gap-1 border-b border-line">
    <For each={props.tabs}>
      {(tab) => (
        <button
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
