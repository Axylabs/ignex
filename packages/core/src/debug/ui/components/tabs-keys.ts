/**
 * @fileoverview Keyboard-navigation math for the `Tabs` primitive. Kept pure
 * (no DOM) so the roving-focus logic is unit-testable in the node test
 * environment, where the Solid `.tsx` cannot be imported.
 */

/** The navigation a key requests against the tab strip (`null` = not handled). */
export type TabKeyTarget = "first" | "last" | "next" | "prev" | null;

/** Map a keydown key to the navigation it requests. */
export const tabKeyTarget = (key: string): TabKeyTarget => {
  switch (key) {
    case "ArrowRight":
      return "next";
    case "ArrowLeft":
      return "prev";
    case "Home":
      return "first";
    case "End":
      return "last";
    default:
      return null;
  }
};

/**
 * Resolve a navigation target to the tab index it lands on, wrapping at the
 * ends for arrow keys. Returns `null` when the key is unhandled or the strip is
 * empty.
 */
export const nextTabIndex = (target: TabKeyTarget, index: number, count: number): number | null => {
  if (target === null || count <= 0) return null;
  switch (target) {
    case "first":
      return 0;
    case "last":
      return count - 1;
    case "next":
      return (index + 1) % count;
    case "prev":
      return (index - 1 + count) % count;
  }
};
