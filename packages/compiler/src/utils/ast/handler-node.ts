/**
 * @fileoverview Handler-shape primitives — the pure "find the handler function
 * in a route module" layer.
 *
 * Split out of `./handler` so that constant analysis (`./constant`) can resolve
 * a module's handler without importing `./handler`, which itself imports
 * `./constant` for guard-object evaluation. That pair was an import cycle
 * (caught by `scripts/check-layers.ts`).
 */

import { bindingName, type FunctionNode, type Node, type Program } from "./ast-types";
import { walk, walkUntil } from "./walk";

export const HTTP_WRAPPERS = new Set(["get", "post", "put", "patch", "del", "all"]);

/**
 * Higher-order route-handler wrappers the compiler recognizes. `withGuards`
 * is the CONVENTIONAL boilerplate wrapper name (the app's own template keeps
 * this name — the compiler optimization resolves its guards at build time).
 * Any OTHER wrapper call is still treated as hook-capable (never hoisted,
 * runtime config read) via the generic `wrappedHandler` flag.
 */
export const HANDLER_WRAPPERS = new Set(["withGuards"]);

/**
 * Unwrap a handler-shaped node to its actual function node, or `null` when
 * the node is not a handler function (including referenced handlers like
 * `get(myHandler)`).
 */
export function unwrapHandlerFunction(node: Node | null | undefined): FunctionNode | null {
  if (!node) return null;
  if (node.type === "CallExpression" && node.callee?.type === "Identifier") {
    const callee = node.callee.name;
    if (HTTP_WRAPPERS.has(callee)) {
      const arg = node.arguments?.[0];
      if (!arg) return null;
      if (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") {
        return arg;
      }
      // `get(myHandler)` — referenced handler, not inline-able.
      return null;
    }
    if (HANDLER_WRAPPERS.has(callee)) {
      // `withGuards(innerHandler, guards)` — recurse into the inner handler.
      return unwrapHandlerFunction(node.arguments?.[0]);
    }
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return node;
  }
  if (node.type === "FunctionDeclaration") return node;
  return null;
}

/** One named-export handler candidate. */
export interface NamedHandlerCandidate {
  readonly name: string;
  /** The node handed to `unwrapHandlerFunction` (init or function declaration). */
  readonly node: Node;
  /**
   * Selection rank (lower wins): 0 = explicit HTTP wrapper (`get(...)`),
   * 1 = handler wrapper (`withGuards(...)`), 2 = function declaration,
   * 3 = bare arrow/function expression.
   */
  readonly rank: number;
}

/** The wrapper kind of a call node, or `null` when it is not a wrapper call. */
const wrapperKind = (node: Node): "http" | "handler" | null => {
  if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return null;
  const name = node.callee.name;
  if (HTTP_WRAPPERS.has(name)) return "http";
  if (HANDLER_WRAPPERS.has(name)) return "handler";
  return null;
};

/** Build a candidate for a variable-export initializer, if it is handler-shaped. */
const toCandidate = (name: string, init: Node): NamedHandlerCandidate | undefined => {
  const wrapper = wrapperKind(init);
  if (wrapper === "http") return { name, node: init, rank: 0 };
  if (wrapper === "handler") return { name, node: init, rank: 1 };
  if (init.type === "ArrowFunctionExpression" || init.type === "FunctionExpression") {
    return { name, node: init, rank: 3 };
  }
  return undefined;
};

/** Append every handler candidate declared by one export declaration. */
const collectCandidates = (node: Node, out: NamedHandlerCandidate[]): void => {
  if (node.type !== "ExportNamedDeclaration" || !node.declaration) return;
  if (node.declaration.type === "VariableDeclaration") {
    for (const d of node.declaration.declarations || []) {
      const name = bindingName(d.id);
      if (!name || !d.init) continue;
      const candidate = toCandidate(name, d.init);
      if (candidate) out.push(candidate);
    }
    return;
  }
  if (node.declaration.type === "FunctionDeclaration" && node.declaration.id?.name) {
    out.push({ name: node.declaration.id.name, node: node.declaration, rank: 2 });
  }
};

/**
 * Every handler-shaped named export in the module, in source order.
 *
 * A route file may export helpers alongside the handler
 * (`export const helper = (x) => …; export const httpGet = get(…)`). Selecting
 * the FIRST arrow function would treat the helper as the route handler — and,
 * through constant-response analysis, could even hoist a response built from
 * the helper's return value. `pickNamedHandler` therefore ranks explicit
 * wrapper calls above declarations above bare functions.
 */
export const namedHandlerCandidates = (ast: Program): NamedHandlerCandidate[] => {
  const out: NamedHandlerCandidate[] = [];
  walk(ast, (node) => {
    collectCandidates(node, out);
    return undefined;
  });
  return out;
};

/** The most likely route handler among a module's named exports. */
export const pickNamedHandler = (ast: Program): NamedHandlerCandidate | undefined => {
  let best: NamedHandlerCandidate | undefined;
  for (const candidate of namedHandlerCandidates(ast)) {
    if (best === undefined || candidate.rank < best.rank) best = candidate;
  }
  return best;
};

/**
 * Resolve the actual handler function node from a module — default or named
 * (`export const httpGet = get(...)`, `export function httpGet(...)`).
 * Returns `null` when no handler is present, the handler is a referenced
 * identifier that cannot be inlined, or the module only has a default export
 * that is not a function. Used by constant-response analysis.
 */
export function extractHandlerNodeAST(ast: Program): FunctionNode | null {
  // Priority 1: default export.
  const defaultExport = walkUntil(ast, (n) =>
    n.type === "ExportDefaultDeclaration" ? n : undefined,
  );
  if (defaultExport) {
    const fn = unwrapHandlerFunction(defaultExport.declaration);
    if (fn) return fn;
  }

  // Priority 2: named handler export (wrapper call first).
  const candidate = pickNamedHandler(ast);
  return candidate ? unwrapHandlerFunction(candidate.node) : null;
}
