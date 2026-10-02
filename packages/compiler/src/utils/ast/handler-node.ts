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

  // Priority 2: named handler export.
  let found: FunctionNode | null = null;
  walk(ast, (n) => {
    if (found) return;
    if (n.type !== "ExportNamedDeclaration") return;

    if (n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        const name = bindingName(d.id);
        if (!name || !d.init) continue;
        const fn = unwrapHandlerFunction(d.init);
        if (fn) {
          found = fn;
          return;
        }
      }
    } else if (n.declaration?.type === "FunctionDeclaration" && n.declaration.id?.name) {
      const fn = unwrapHandlerFunction(n.declaration);
      if (fn) {
        found = fn;
        return;
      }
    }
  });

  return found ?? null;
}
