/**
 * @fileoverview Route handler extraction.
 *
 * Pulls the handler function out of a route module — either the default
 * export (`export default get(ctx => …)`) or a named binding
 * (`export const httpGet = get(ctx => …)`, `export function httpGet(ctx){}`).
 *
 * A handler is only "extractable" (an inline candidate) when its function is
 * literally present in the module; a wrapper call whose argument is a
 * referenced identifier (`get(myHandler)`) is still recognized as a route but
 * cannot be inlined.
 */

import { bindingName, type FunctionNode, type Node, type Program } from "./ast-types";
import { hasDefaultExportAST } from "./imports";
import type { ExtractedHandler } from "./types";
import { buildContextMapping, detectUsage } from "./usage";
import { nodeEnd, nodeStart, walk, walkUntil } from "./walk";

export type { ExtractedHandler };

const HTTP_WRAPPERS = new Set(["get", "post", "put", "patch", "del", "all"]);

/**
 * Unwrap a handler-shaped node to its actual function node, or `null` when
 * the node is not a handler function (including referenced handlers like
 * `get(myHandler)`).
 */
export function unwrapHandlerFunction(node: Node | null | undefined): FunctionNode | null {
  if (!node) return null;
  if (
    node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    HTTP_WRAPPERS.has(node.callee.name)
  ) {
    const arg = node.arguments?.[0];
    if (!arg) return null;
    if (arg.type === "ArrowFunctionExpression" || arg.type === "FunctionExpression") {
      return arg;
    }
    // `get(myHandler)` — referenced handler, not inline-able.
    return null;
  }
  if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression") {
    return node;
  }
  if (node.type === "FunctionDeclaration") return node;
  return null;
}

/** Wrapper-compatible extraction returning the function node + async flag. */
const extractHandlerFunction = (
  node: Node | null | undefined,
): { fn: FunctionNode; isAsync: boolean } | null => {
  const fn = unwrapHandlerFunction(node);
  return fn ? { fn, isAsync: fn.async ?? false } : null;
};

const buildExtractedHandler = (
  source: string,
  fn: FunctionNode,
  isAsync: boolean,
  exportKind: "default" | "named",
  exportName?: string,
): ExtractedHandler => {
  const params = Array.isArray(fn.params) ? fn.params : [];
  const mapping = buildContextMapping(params);
  const rootParam = params[0]?.type === "Identifier" ? params[0].name : "ctx";
  const isSimpleParam = params[0]?.type === "Identifier";

  let bodyText = "";
  const body = fn.body;

  if (body && typeof source === "string") {
    const start = nodeStart(body);
    const end = nodeEnd(body);

    if (start != null && end != null) {
      if (body.type === "BlockStatement") {
        bodyText = source.slice(start + 1, end - 1).trim();
      } else {
        bodyText = `return ${source.slice(start, end).trim()};`;
      }
    }
  }

  const usage = detectUsage(body || fn, mapping);

  const handler: ExtractedHandler = {
    body: bodyText,
    isAsync,
    paramName: rootParam,
    isSimpleParam,
    usage,
    exportKind,
    ...(exportName !== undefined ? { exportName } : {}),
  };

  return handler;
};

/**
 * Default-export handler extraction.
 *
 * Kept for API compatibility; {@link extractHandlerExport} also understands
 * named exports (`export const httpGet = get(...)`).
 */
export function extractHandler(source: string, ast: Program): ExtractedHandler | null {
  const defaultExport = walkUntil(ast, (n) =>
    n.type === "ExportDefaultDeclaration" ? n : undefined,
  );
  if (!defaultExport) return null;

  const extracted = extractHandlerFunction(defaultExport.declaration);
  if (!extracted) return null;

  return buildExtractedHandler(source, extracted.fn, extracted.isAsync, "default");
}

/**
 * True when a node is a handler-shaped initializer: an HTTP wrapper call
 * (`get(...)`, `post(...)`, ...), a bare arrow function, or a function
 * expression. Note this is broader than `extractHandlerFunction`: a wrapper
 * call whose argument is a referenced identifier (`get(myHandler)`) still
 * counts as a handler export even though it cannot be inlined.
 */
export const isHandlerInitNode = (node: Node): boolean =>
  (node.type === "CallExpression" &&
    node.callee?.type === "Identifier" &&
    HTTP_WRAPPERS.has(node.callee.name)) ||
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression";

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

/**
 * Extract the first exported route handler from a module — default OR named
 * (`export const httpGet = get(...)`, `export function httpGet(...)`).
 * Returns `null` when no handler is present or the handler is a referenced
 * identifier that cannot be inlined.
 */
export function extractHandlerExport(source: string, ast: Program): ExtractedHandler | null {
  // Priority 1: default export (existing behavior).
  const defaultExport = walkUntil(ast, (n) =>
    n.type === "ExportDefaultDeclaration" ? n : undefined,
  );
  if (defaultExport) {
    const extracted = extractHandlerFunction(defaultExport.declaration);
    if (extracted) {
      return buildExtractedHandler(source, extracted.fn, extracted.isAsync, "default");
    }
  }

  // Priority 2: named handler export.
  let found: ExtractedHandler | null = null;
  walk(ast, (n) => {
    if (found) return;
    if (n.type !== "ExportNamedDeclaration") return;

    if (n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        const name = bindingName(d.id);
        if (!name || !d.init) continue;
        const extracted = extractHandlerFunction(d.init);
        if (extracted) {
          found = buildExtractedHandler(source, extracted.fn, extracted.isAsync, "named", name);
          return;
        }
      }
    } else if (n.declaration?.type === "FunctionDeclaration" && n.declaration.id?.name) {
      const extracted = extractHandlerFunction(n.declaration);
      if (extracted) {
        found = buildExtractedHandler(
          source,
          extracted.fn,
          extracted.isAsync,
          "named",
          n.declaration.id.name,
        );
        return;
      }
    }
  });

  return found;
}

/**
 * True when a module exports a route handler — as a default export, or as a
 * named export bound to a handler-shaped initializer. Used to decide whether
 * a route module should participate in the route graph at all.
 */
export function hasHandlerExportAST(ast: Program): boolean {
  let found = false;
  walk(ast, (n) => {
    if (found) return;

    if (n.type === "ExportDefaultDeclaration") {
      found = true;
      return;
    }

    if (n.type === "ExportNamedDeclaration") {
      if (n.declaration?.type === "VariableDeclaration") {
        for (const d of n.declaration.declarations || []) {
          if (bindingName(d.id) && d.init && isHandlerInitNode(d.init)) {
            found = true;
            return;
          }
        }
      } else if (n.declaration?.type === "FunctionDeclaration") {
        found = true;
        return;
      }
    }
  });
  return found;
}

/**
 * The named export identifier to import when a module's handler cannot be
 * inlined (e.g. `export const httpGet = get(myHandler)`). Returns `undefined`
 * for default-export modules, which are imported as default.
 */
export function extractHandlerExportName(ast: Program): string | undefined {
  if (hasDefaultExportAST(ast)) return undefined;

  let name: string | undefined;
  walk(ast, (n) => {
    if (name !== undefined) return;
    if (n.type !== "ExportNamedDeclaration") return;

    if (n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        const idName = bindingName(d.id);
        if (idName && d.init && isHandlerInitNode(d.init)) {
          name = idName;
          return;
        }
      }
    } else if (n.declaration?.type === "FunctionDeclaration" && n.declaration.id?.name) {
      name = n.declaration.id.name;
      return;
    }
  });
  return name;
}
