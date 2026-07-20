/**
 * @fileoverview Segment Trie — Refactored into small, pure, composable functions.
 * All operations are pure: they return new nodes rather than mutating.
 */

import type { RouteDef, SegNode, Terminal, HttpMethod } from "../types";
import { segmentHash } from "./hash";

// ============================================================================
// Node Factory — Pure
// ============================================================================

/**
 * Create a fresh trie node with default empty children.
 * @param {number} depth - Node depth in the trie (0 = root)
 * @returns {SegNode} New immutable trie node
 */
export const createSegNode = (depth = 0): SegNode => ({
  terminals: new Map(),
  staticChildren: new Map(),
  paramChild: null,
  catchAll: new Map(),
  depth,
});

// ============================================================================
// Terminal Creation — Pure
// ============================================================================

/**
 * Build a Terminal record from a RouteDef.
 * @param {RouteDef} route - Route definition
 * @param {number} routeIdx - Route index for reference
 * @returns {Terminal} Terminal node data
 */
export const createTerminal = (route: RouteDef, routeIdx: number): Terminal => ({
  method: route.method,
  handlerRef: route.handlerRef,
  schemaRef: route.schemaRef,
  paramNames: route.paramNames,
  routeIdx,
});

// ============================================================================
// Segment Classification — Pure
// ============================================================================

/**
 * Check if a segment is a catch-all parameter ([...name]).
 * @param {string} seg - Path segment
 * @returns {boolean} True if catch-all
 */
export const isCatchAllSegment = (seg: string): boolean => seg.startsWith("*");

/**
 * Check if a segment is a named parameter (:name).
 * @param {string} seg - Path segment
 * @returns {boolean} True if parameter
 */
export const isParamSegment = (seg: string): boolean => seg.startsWith(":");

/**
 * Extract parameter name from a segment.
 * @param {string} seg - Parameter segment
 * @returns {string} Parameter name without prefix
 */
export const extractParamName = (seg: string): string =>
  isCatchAllSegment(seg) ? seg.slice(1) : seg.slice(1);

// ============================================================================
// Node Updates — Pure, Immutable
// ============================================================================

/**
 * Attach a terminal to a node, returning a new node.
 * @param {SegNode} node - Target node
 * @param {HttpMethod} method - HTTP method
 * @param {Terminal} terminal - Terminal data
 * @returns {SegNode} New node with terminal attached
 */
export const attachTerminal = (
  node: SegNode,
  method: HttpMethod,
  terminal: Terminal
): SegNode => {
  const newTerminals = new Map(node.terminals);
  newTerminals.set(method, terminal);
  return { ...node, terminals: newTerminals };
};

/**
 * Attach a catch-all handler to a node, returning a new node.
 * @param {SegNode} node - Target node
 * @param {HttpMethod} method - HTTP method
 * @param {string} name - Catch-all parameter name
 * @param {string} handlerRef - Handler reference
 * @param {string | null} schemaRef - Schema reference
 * @returns {SegNode} New node with catch-all attached
 */
export const attachCatchAll = (
  node: SegNode,
  method: HttpMethod,
  name: string,
  handlerRef: string,
  schemaRef: string | null
): SegNode => {
  const newCatchAll = new Map(node.catchAll);
  newCatchAll.set(method, { name, handlerRef, schemaRef });
  return { ...node, catchAll: newCatchAll };
};

/**
 * Attach or update a param child, returning a new node.
 * @param {SegNode} node - Target node
 * @param {string} name - Parameter name
 * @param {SegNode} child - Child node
 * @returns {SegNode} New node with param child updated
 */
export const attachParamChild = (
  node: SegNode,
  name: string,
  child: SegNode
): SegNode => ({
  ...node,
  paramChild: { name, child },
});

/**
 * Attach or update a static child, returning a new node.
 * @param {SegNode} node - Target node
 * @param {string} seg - Static segment
 * @param {SegNode} child - Child node
 * @returns {SegNode} New node with static child updated
 */
export const attachStaticChild = (
  node: SegNode,
  seg: string,
  child: SegNode
): SegNode => {
  const newStaticChildren = new Map(node.staticChildren);
  newStaticChildren.set(seg, child);
  return { ...node, staticChildren: newStaticChildren };
};

// ============================================================================
// Route Insertion — Pure, Recursive
// ============================================================================

/**
 * Split a path into segments.
 * @param {string} path - Route path
 * @returns {string[]} Non-empty segments
 */
export const splitPath = (path: string): string[] =>
  path.split("/").filter(Boolean);

/**
 * Insert a route into a trie at a specific segment index.
 * Recursive helper that rebuilds the path from root to leaf.
 * @param {SegNode} node - Current trie node
 * @param {RouteDef} route - Route to insert
 * @param {readonly string[]} segs - Path segments
 * @param {number} segIdx - Current segment index
 * @returns {SegNode} New trie with route inserted
 */
export const insertAt = (
  node: SegNode,
  route: RouteDef,
  segs: readonly string[],
  segIdx: number
): SegNode => {
  // Leaf: attach terminal
  if (segIdx >= segs.length) {
    const routeIdx = parseInt(route.handlerRef.slice(2)) || 0;
    return attachTerminal(node, route.method, createTerminal(route, routeIdx));
  }

  const seg = segs[segIdx]!;

  // Catch-all segment
  if (isCatchAllSegment(seg)) {
    return attachCatchAll(
      node,
      route.method,
      extractParamName(seg),
      route.handlerRef,
      route.schemaRef
    );
  }

  // Param segment
  if (isParamSegment(seg)) {
    const existing = node.paramChild;
    if (!existing) {
      return attachParamChild(
        node,
        extractParamName(seg),
        insertAt(createSegNode(node.depth + 1), route, segs, segIdx + 1)
      );
    }
    return attachParamChild(
      node,
      existing.name,
      insertAt(existing.child, route, segs, segIdx + 1)
    );
  }

  // Static segment
  const child = node.staticChildren.get(seg);
  if (!child) {
    return attachStaticChild(
      node,
      seg,
      insertAt(createSegNode(node.depth + 1), route, segs, segIdx + 1)
    );
  }
  return attachStaticChild(node, seg, insertAt(child, route, segs, segIdx + 1));
};

/**
 * Insert a route into a trie. Returns a NEW trie (immutable update).
 * @param {SegNode} root - Root trie node
 * @param {RouteDef} route - Route to insert
 * @returns {SegNode} New trie with route inserted
 */
export const insertRoute = (root: SegNode, route: RouteDef): SegNode =>
  insertAt(root, route, splitPath(route.path), 0);

// ============================================================================
// Trie Construction — Pure
// ============================================================================

/**
 * Filter routes to only dynamic ones.
 * @param {readonly RouteDef[]} routes - All routes
 * @returns {RouteDef[]} Dynamic routes only
 */
export const filterDynamicRoutes = (routes: readonly RouteDef[]): RouteDef[] =>
  routes.filter((r) => r.isDynamic);

/**
 * Build a trie from dynamic routes only.
 * Static routes are handled by the jump table.
 * @param {readonly RouteDef[]} routes - All routes
 * @returns {SegNode} Root trie node
 */
export const buildTrie = (routes: readonly RouteDef[]): SegNode => {
  const dynamicRoutes = filterDynamicRoutes(routes);
  let root = createSegNode(0);
  for (const route of dynamicRoutes) {
    root = insertRoute(root, route);
  }
  return root;
};

// ============================================================================
// Unreachable Route Detection — Pure
// ============================================================================

/**
 * Check if a route is shadowed by a catch-all at the current trie level.
 * @param {SegNode} node - Current trie node
 * @param {HttpMethod} method - HTTP method
 * @returns {boolean} True if catch-all exists for method
 */
export const hasCatchAllForMethod = (node: SegNode, method: HttpMethod): boolean =>
  node.catchAll.has(method);

/**
 * Navigate to the next trie node based on segment type.
 * @param {SegNode} node - Current node
 * @param {string} seg - Path segment
 * @returns {SegNode | null} Next node, or null if path breaks
 */
export const navigateSegment = (node: SegNode, seg: string): SegNode | null => {
  if (isParamSegment(seg)) {
    return node.paramChild?.child ?? null;
  }
  if (isCatchAllSegment(seg)) {
    return null; // catch-all terminates navigation
  }
  return node.staticChildren.get(seg) ?? null;
};

/**
 * Check if a dynamic route is unreachable due to shadowing.
 * @param {SegNode} root - Trie root
 * @param {RouteDef} route - Route to check
 * @returns {boolean} True if unreachable
 */
export const isUnreachableDynamic = (root: SegNode, route: RouteDef): boolean => {
  const segs = splitPath(route.path);
  let node = root;

  for (let i = 0; i < segs.length; i++) {
    if (hasCatchAllForMethod(node, route.method)) {
      return true;
    }

    const seg = segs[i]!;
    if (isCatchAllSegment(seg)) return false; // route IS the catch-all

    const next = navigateSegment(node, seg);
    if (!next) return false;
    node = next;
  }
  return false;
};

/**
 * Create a unique key for route deduplication.
 * @param {RouteDef} route - Route
 * @returns {string} Key like "GET:/users"
 */
export const routeKey = (route: RouteDef): string => `${route.method}:${route.path}`;

/**
 * Find duplicate static routes.
 * @param {readonly RouteDef[]} staticRoutes - Static routes
 * @returns {RouteDef[]} Duplicate routes
 */
export const findDuplicateStatics = (staticRoutes: readonly RouteDef[]): RouteDef[] => {
  const seen = new Map<string, RouteDef>();
  const duplicates: RouteDef[] = [];

  for (const route of staticRoutes) {
    const key = routeKey(route);
    if (seen.has(key)) {
      duplicates.push(route);
    } else {
      seen.set(key, route);
    }
  }
  return duplicates;
};

/**
 * Detect unreachable routes shadowed by catch-all or param conflicts.
 * @param {SegNode} root - Trie root
 * @param {readonly RouteDef[]} staticRoutes - Static routes
 * @returns {RouteDef[]} Unreachable routes
 */
export const detectUnreachable = (
  root: SegNode,
  staticRoutes: readonly RouteDef[]
): RouteDef[] => findDuplicateStatics(staticRoutes);

// ============================================================================
// Statistics — Pure
// ============================================================================

/**
 * Calculate branching factor for a single node.
 * @param {SegNode} node - Trie node
 * @returns {number} Number of child edges
 */
export const nodeBranchCount = (node: SegNode): number =>
  node.staticChildren.size + (node.paramChild ? 1 : 0);

/**
 * Recursively collect trie statistics.
 * @param {SegNode} node - Current node
 * @param {number} depth - Current depth
 * @returns {{ maxDepth: number; totalNodes: number; totalBranches: number }} Accumulated stats
 */
export const collectTrieStats = (
  node: SegNode,
  depth: number
): { maxDepth: number; totalNodes: number; totalBranches: number } => {
  let maxDepth = depth;
  let totalNodes = 1;
  let totalBranches = nodeBranchCount(node);

  for (const child of node.staticChildren.values()) {
    const childStats = collectTrieStats(child, depth + 1);
    maxDepth = Math.max(maxDepth, childStats.maxDepth);
    totalNodes += childStats.totalNodes;
    totalBranches += childStats.totalBranches;
  }

  if (node.paramChild) {
    const childStats = collectTrieStats(node.paramChild.child, depth + 1);
    maxDepth = Math.max(maxDepth, childStats.maxDepth);
    totalNodes += childStats.totalNodes;
    totalBranches += childStats.totalBranches;
  }

  return { maxDepth, totalNodes, totalBranches };
};

/**
 * Compute trie statistics for optimization decisions.
 * @param {SegNode} node - Trie root
 * @returns {{ maxDepth: number; totalNodes: number; avgBranching: number }} Trie stats
 */
export const trieStats = (node: SegNode): { maxDepth: number; totalNodes: number; avgBranching: number } => {
  const stats = collectTrieStats(node, 0);
  return {
    maxDepth: stats.maxDepth,
    totalNodes: stats.totalNodes,
    avgBranching: stats.totalNodes > 1 ? stats.totalBranches / (stats.totalNodes - 1) : 0,
  };
};

// ============================================================================
// Pretty Printing — Pure
// ============================================================================

/**
 * Generate indentation string.
 * @param {number} level - Indentation level
 * @returns {string} Spaces for indentation
 */
export const indent = (level: number): string => "  ".repeat(level);

/**
 * Pretty-print terminal entries at a node.
 * @param {SegNode} node - Trie node
 * @param {number} level - Indentation level
 * @returns {string} Formatted terminal lines
 */
export const printTerminals = (node: SegNode, level: number): string => {
  let out = "";
  for (const [method, term] of node.terminals) {
    out += `${indent(level)}[${method}] → ${term.handlerRef}\n`;
  }
  return out;
};

/**
 * Pretty-print static children.
 * @param {SegNode} node - Trie node
 * @param {number} level - Indentation level
 * @returns {string} Formatted child lines
 */
export const printStaticChildren = (node: SegNode, level: number): string => {
  let out = "";
  for (const [seg, child] of node.staticChildren) {
    out += `${indent(level)}"${seg}"\n`;
    out += printTrie(child, level + 1);
  }
  return out;
};

/**
 * Pretty-print param child.
 * @param {SegNode} node - Trie node
 * @param {number} level - Indentation level
 * @returns {string} Formatted param line
 */
export const printParamChild = (node: SegNode, level: number): string => {
  if (!node.paramChild) return "";
  return (
    `${indent(level)}:${node.paramChild.name}\n` +
    printTrie(node.paramChild.child, level + 1)
  );
};

/**
 * Pretty-print catch-all entries.
 * @param {SegNode} node - Trie node
 * @param {number} level - Indentation level
 * @returns {string} Formatted catch-all lines
 */
export const printCatchAlls = (node: SegNode, level: number): string => {
  let out = "";
  for (const [method, ca] of node.catchAll) {
    out += `${indent(level)}*${ca.name} [${method}]\n`;
  }
  return out;
};

/**
 * Pretty-print a trie for debugging. Pure (returns string).
 * @param {SegNode} node - Trie root
 * @param {number} level - Current indentation level
 * @returns {string} Human-readable trie representation
 */
export const printTrie = (node: SegNode, level = 0): string =>
  printTerminals(node, level) +
  printStaticChildren(node, level) +
  printParamChild(node, level) +
  printCatchAlls(node, level);