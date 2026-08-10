/**
 * @fileoverview Minimal ESTree walker primitives shared by every AST analysis
 * module (usage detection, handler extraction, purity, constants, symbols…).
 *
 * Zero-dependency and parser-agnostic: it works with the node shapes emitted
 * by `oxc-parser` and `Bun.Transpiler` alike (`range` / `span` / `start` /
 * `end` offsets, optional `loc`). The walker only descends into object-shaped
 * children that carry a `type` and skips metadata keys (`parent`, `loc`,
 * `range`, `span`, offsets), so it never does extra work on parser-internal
 * bookkeeping and never follows a `parent` link back up the tree.
 *
 * Hardening notes:
 * - A depth guard prevents stack overflow on pathologically deep input
 *   (e.g. `((((…))))`). Real modules stay far below the limit.
 * - {@link walkUntil} short-circuits the entire subtree the moment the
 *   predicate hits — a constant factor win for every "does the module have
 *   an X export?" check.
 */

import type { Node } from "./ast-types";

/** Node metadata keys that must never be traversed. */
const SKIP_KEYS = new Set<string>(["parent", "loc", "range", "span", "start", "end"]);

/**
 * Maximum nesting depth we will traverse. Guards against stack overflow on
 * adversarial input; realistic source nests orders of magnitude shallower.
 */
const MAX_DEPTH = 1000;

/** First node offset (inclusive) for slicing source text. */
export const nodeStart = (node: Node | undefined): number | undefined =>
  node?.range?.[0] ?? node?.start ?? node?.span?.[0];

/** Last node offset (exclusive) for slicing source text. */
export const nodeEnd = (node: Node | undefined): number | undefined =>
  node?.range?.[1] ?? node?.end ?? node?.span?.[1];

/** True when a value looks like an ESTree node (object with a string `type`). */
const isNode = (value: unknown): value is Node =>
  !!value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string";

/**
 * Depth-first traversal invoking `cb` on every node. If `cb` returns `false`
 * the current subtree is pruned (children are not visited) — useful for
 * skipping nested function bodies during whole-module scans.
 */
export function walk(
  node: Node | undefined,
  cb: (node: Node) => undefined | false,
  depth = 0,
): void {
  if (!isNode(node) || depth >= MAX_DEPTH) return;
  if (cb(node) === false) return;

  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue;
    const child = node[key as keyof Node];
    if (Array.isArray(child)) {
      for (const c of child) if (isNode(c)) walk(c, cb, depth + 1);
    } else if (isNode(child)) {
      walk(child, cb, depth + 1);
    }
  }
}

/**
 * Depth-first search that stops as soon as `predicate` returns a value.
 * Returns the first non-`undefined` predicate result, or `undefined` when no
 * node matches. Because traversal halts on the first hit, this is O(distance
 * to match) instead of O(whole tree).
 */
export function walkUntil<T>(
  node: Node | undefined,
  predicate: (node: Node) => T | undefined,
): T | undefined {
  if (!isNode(node)) return undefined;

  const rec = (n: Node, depth: number): T | undefined => {
    if (depth >= MAX_DEPTH) return undefined;
    const hit = predicate(n);
    if (hit !== undefined) return hit;

    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = n[key as keyof Node];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (!isNode(c)) continue;
          const found = rec(c, depth + 1);
          if (found !== undefined) return found;
        }
      } else if (isNode(child)) {
        const found = rec(child, depth + 1);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };

  return rec(node, 0);
}

/**
 * Walk until `visit` returns `true`. Returns `true` when traversal was
 * stopped early by the visitor, `false` when the whole tree was exhausted.
 * Useful for multi-condition scans that should halt once every condition is
 * resolved (e.g. module export classification).
 */
export function walkSome(node: Node | undefined, visit: (node: Node) => boolean): boolean {
  if (!isNode(node)) return false;

  const rec = (n: Node, depth: number): boolean => {
    if (depth >= MAX_DEPTH) return false;
    if (visit(n)) return true;

    for (const key of Object.keys(n)) {
      if (SKIP_KEYS.has(key)) continue;
      const child = n[key as keyof Node];
      if (Array.isArray(child)) {
        for (const c of child) {
          if (!isNode(c)) continue;
          if (rec(c, depth + 1)) return true;
        }
      } else if (isNode(child)) {
        if (rec(child, depth + 1)) return true;
      }
    }
    return false;
  };

  return rec(node, 0);
}
