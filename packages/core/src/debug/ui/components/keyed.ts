/**
 * @fileoverview Keyed list identity helper.
 *
 * Solid's `<For>` reuses row DOM when item references are equal. Server
 * fetches return fresh objects every time, so rows would be rebuilt on every
 * stream bump; this merge keeps the previous object for keys that are still
 * present, preserving row DOM (open `<details>`, focus, flash state) while
 * new/removed rows still reconcile.
 */

/**
 * Merge a fetched list into a keyed Map, preserving item identity for keys
 * that already exist in `prev`. Insertion order follows `items`.
 */
export const mergeById = <T>(
  prev: ReadonlyMap<string, T>,
  items: readonly T[],
  key: (item: T) => string,
): Map<string, T> => {
  const next = new Map<string, T>();
  for (const item of items) {
    const k = key(item);
    const old = prev.get(k);
    next.set(k, old !== undefined ? old : item);
  }
  return next;
};
