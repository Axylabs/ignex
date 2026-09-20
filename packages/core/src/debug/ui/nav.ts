/**
 * @fileoverview Grouped-navigation model — the debugbar sidebar's four labelled
 * sections and the per-view icon mapping. Pure data plus one filter, so the
 * shell and the command palette render the same grouping the view registry
 * declares instead of duplicating it.
 */
import type { IconName } from "./components/icon";
import { VIEWS, type ViewDef } from "./views/registry";

/** A labelled sidebar section. */
export interface NavGroup {
  /** Stable group key (used for keys and tests). */
  id: string;
  /** Section heading; `null` for an unlabelled group. */
  label: string | null;
  /** Present views, in the group's declared order. */
  items: ViewDef[];
}

/**
 * Sidebar groups and their membership, in display order. `routes` is
 * deliberately absent — it is reachable from the command palette and deep
 * links, not the sidebar (spec §6.2/§6.3).
 */
const GROUP_ORDER: readonly { id: string; label: string | null; ids: readonly string[] }[] = [
  { id: "observe", label: "Observe", ids: ["requests", "errors", "logs", "history"] },
  { id: "runtime", label: "Runtime", ids: ["metrics", "system", "diagnostics", "state", "jobs"] },
  { id: "integrations", label: "Integrations", ids: ["events", "clients"] },
  { id: "reference", label: "Reference", ids: ["kt", "docs", "ai"] },
];

/**
 * Partition views into the ordered groups, preserving the caller's view
 * objects and dropping any group that ends up empty.
 */
export const navGroups = (views: ViewDef[]): NavGroup[] => {
  const byId = new Map(views.map((view) => [view.id, view]));
  const groups: NavGroup[] = [];
  for (const group of GROUP_ORDER) {
    const items: ViewDef[] = [];
    for (const id of group.ids) {
      const view = byId.get(id);
      if (view !== undefined) items.push(view);
    }
    if (items.length > 0) groups.push({ id: group.id, label: group.label, items });
  }
  return groups;
};

/** The sidebar grouping of the real view registry. */
export const NAV_GROUPS: NavGroup[] = navGroups(VIEWS);

/** Icon per view id (all 15 registry views). */
const VIEW_ICONS: Record<string, IconName> = {
  requests: "list",
  errors: "alert",
  logs: "terminal",
  history: "clock",
  metrics: "activity",
  system: "cpu",
  diagnostics: "stethoscope",
  state: "layers",
  jobs: "briefcase",
  events: "radio",
  routes: "route",
  clients: "package",
  kt: "book",
  docs: "file-text",
  ai: "sparkles",
};

/** Look up a view's icon; unknown ids fall back to `list`. */
export const iconForView = (id: string): IconName => VIEW_ICONS[id] ?? "list";
