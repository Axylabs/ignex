/**
 * @fileoverview Grouped-navigation model tests.
 *
 * The view registry is a Solid `.tsx` module that cannot be transformed under
 * the repo's `jsx: "preserve"` test config, so it is stubbed here: `navGroups`
 * is exercised directly with explicit views, and `NAV_GROUPS` against the stub.
 */
import { describe, expect, it, vi } from "vitest";

import { iconForView, NAV_GROUPS, navGroups } from "../src/debug/ui/nav";
import { buildCommands } from "../src/debug/ui/palette";
import { registryViews } from "./helpers/debug-ui-registry";

vi.mock("../src/debug/ui/views/registry", async () => {
  const { registryViews: parse } = await import("./helpers/debug-ui-registry");
  return {
    VIEWS: parse().map(({ id, label }) => ({
      id,
      label,
      key: "",
      domain: null,
      component: () => null,
    })),
  };
});

const v = (id: string) =>
  ({ id, label: id, key: "", domain: null, component: () => null }) as never;

describe("navGroups", () => {
  it("partitions known views into four ordered groups", () => {
    const ids = [
      "requests",
      "errors",
      "logs",
      "history",
      "routes",
      "metrics",
      "system",
      "diagnostics",
      "state",
      "jobs",
      "events",
      "clients",
      "kt",
      "docs",
      "ai",
    ];
    const groups = navGroups(ids.map(v));
    expect(groups.map((g) => g.label)).toEqual(["Observe", "Runtime", "Integrations", "Reference"]);
    expect(groups[0]!.items.map((i) => i.id)).toEqual([
      "requests",
      "errors",
      "logs",
      "history",
      "routes",
    ]);
    expect(groups[1]!.items.map((i) => i.id)).toEqual([
      "metrics",
      "system",
      "diagnostics",
      "state",
      "jobs",
    ]);
    expect(groups[2]!.items.map((i) => i.id)).toEqual(["events", "clients"]);
    expect(groups[3]!.items.map((i) => i.id)).toEqual(["kt", "docs", "ai"]);

    // Every view present lands in exactly one group — the union is all 15.
    const grouped = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(grouped).toHaveLength(ids.length);
    expect(new Set(grouped)).toEqual(new Set(ids));
  });

  it("drops groups with no present views", () => {
    expect(navGroups([v("requests")]).map((g) => g.id)).toEqual(["observe"]);
  });

  it("keeps each view in exactly one group and preserves per-view objects", () => {
    const views = [v("requests"), v("jobs"), v("docs")];
    const groups = navGroups(views);
    const flattened = groups.flatMap((g) => g.items);
    expect(flattened).toHaveLength(3);
    expect(new Set(flattened.map((i) => i.id)).size).toBe(3);
    // Identity is preserved: the caller's objects are returned, not clones.
    expect(flattened[0]).toBe(views[0]);
  });

  it("ignores views that belong to no group", () => {
    expect(navGroups([v("unknown"), v("requests")]).map((g) => g.id)).toEqual(["observe"]);
  });
});

describe("NAV_GROUPS", () => {
  it("derives the four labelled groups from the registry, in order", () => {
    expect(NAV_GROUPS.map((g) => g.id)).toEqual([
      "observe",
      "runtime",
      "integrations",
      "reference",
    ]);
    expect(NAV_GROUPS.flatMap((g) => g.items.map((i) => i.id))).toEqual([
      "requests",
      "errors",
      "logs",
      "history",
      "routes",
      "metrics",
      "system",
      "diagnostics",
      "state",
      "jobs",
      "events",
      "clients",
      "kt",
      "docs",
      "ai",
    ]);
  });
});

describe("iconForView", () => {
  it("maps each registry view id to its icon", () => {
    expect(iconForView("requests")).toBe("list");
    expect(iconForView("errors")).toBe("alert");
    expect(iconForView("logs")).toBe("terminal");
    expect(iconForView("history")).toBe("clock");
    expect(iconForView("metrics")).toBe("activity");
    expect(iconForView("system")).toBe("cpu");
    expect(iconForView("diagnostics")).toBe("stethoscope");
    expect(iconForView("state")).toBe("layers");
    expect(iconForView("jobs")).toBe("briefcase");
    expect(iconForView("events")).toBe("radio");
    expect(iconForView("routes")).toBe("route");
    expect(iconForView("clients")).toBe("package");
    expect(iconForView("kt")).toBe("book");
    expect(iconForView("docs")).toBe("file-text");
    expect(iconForView("ai")).toBe("sparkles");
  });

  it("falls back for an unknown view id", () => {
    expect(iconForView("nope")).toBe("list");
  });
});

describe("registry drift guard", () => {
  it("covers exactly the registry's views and matches buildCommands order", () => {
    const registryIds = registryViews().map((view) => view.id);

    const navIds = NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id));
    expect(navIds).toHaveLength(registryIds.length);
    expect(new Set(navIds)).toEqual(new Set(registryIds));

    const deps = {
      navigate: () => {},
      toggleTheme: () => {},
      refresh: () => {},
      togglePause: () => {},
    };
    const viewCommands = buildCommands(deps)
      .filter((cmd) => cmd.group === "Views")
      .map((cmd) => cmd.id);
    expect(viewCommands).toEqual(navIds.map((id) => `view:${id}`));
  });
});
