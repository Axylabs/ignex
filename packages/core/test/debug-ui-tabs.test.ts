/**
 * @fileoverview `Tabs` keyboard-navigation logic. The Solid `.tsx` primitive
 * cannot be imported under the repo's `jsx: "preserve"` node test config, so
 * the pure index math it delegates to is exercised directly here; the DOM wiring
 * (focus movement, `preventDefault`) is covered by the executed-bundle smoke.
 */
import { describe, expect, it } from "vitest";

import { nextTabIndex, tabKeyTarget } from "../src/debug/ui/components/tabs-keys";

describe("Tabs keyboard navigation", () => {
  it("maps the WAI-ARIA tab keys and ignores everything else", () => {
    expect(tabKeyTarget("ArrowRight")).toBe("next");
    expect(tabKeyTarget("ArrowLeft")).toBe("prev");
    expect(tabKeyTarget("Home")).toBe("first");
    expect(tabKeyTarget("End")).toBe("last");
    expect(tabKeyTarget("Enter")).toBeNull();
    expect(tabKeyTarget("Tab")).toBeNull();
    expect(tabKeyTarget("a")).toBeNull();
  });

  it("wraps arrow navigation at both ends", () => {
    expect(nextTabIndex("next", 0, 3)).toBe(1);
    expect(nextTabIndex("next", 2, 3)).toBe(0);
    expect(nextTabIndex("prev", 0, 3)).toBe(2);
    expect(nextTabIndex("prev", 1, 3)).toBe(0);
  });

  it("jumps to the first/last tab with Home/End", () => {
    expect(nextTabIndex("first", 2, 3)).toBe(0);
    expect(nextTabIndex("last", 0, 3)).toBe(2);
  });

  it("never moves for an unhandled key or an empty strip", () => {
    expect(nextTabIndex(null, 1, 3)).toBeNull();
    expect(nextTabIndex("next", 0, 0)).toBeNull();
    expect(nextTabIndex("first", 0, 0)).toBeNull();
  });
});
