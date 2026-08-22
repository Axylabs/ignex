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

import type { RouteGuards } from "../../types";
import { bindingName, type FunctionNode, type Node, type Program } from "./ast-types";
import { evaluateConstantNode } from "./constant";
import { hasDefaultExportAST } from "./imports";
import type { ExtractedHandler } from "./types";
import { buildContextMapping, detectUsage } from "./usage";
import { nodeEnd, nodeStart, walk, walkUntil } from "./walk";

export type { ExtractedHandler };

export const HTTP_WRAPPERS = new Set(["get", "post", "put", "patch", "del", "all"]);
/** Alias for scanner consumers (a default-export call whose callee is an HTTP
 * helper is a bare route; any OTHER call is a user wrapper). */
export const HTTP_HELPER_CALLS = HTTP_WRAPPERS;

/**
 * Higher-order route-handler wrappers the compiler recognizes. `withGuards`
 * is the CONVENTIONAL boilerplate wrapper name (the app's own template keeps
 * this name — the compiler optimization resolves its guards at build time).
 * Any OTHER wrapper call is still treated as hook-capable (never hoisted,
 * runtime config read) via the generic `wrappedHandler` flag.
 */
export const HANDLER_WRAPPERS = new Set(["withGuards"]);

/** True when `node` is a recognized route-handler wrapper call. */
const isHandlerWrapperCall = (node: Node): boolean =>
  node.type === "CallExpression" &&
  node.callee?.type === "Identifier" &&
  (HTTP_WRAPPERS.has(node.callee.name) || HANDLER_WRAPPERS.has(node.callee.name));

/**
 * Extract the RBAC guards object from a `withGuards` call (statically
 * evaluated). Supports BOTH forms:
 *   - wrapper form:  `withGuards(handler, guards)`  — guards at argument 1
 *   - guard factory: `withGuards(guards)`          — guards at argument 0
 * Returns `{}` for a bare call (require authentication only) and `undefined`
 * when the init is not a `withGuards` call.
 */
export const extractGuardsFromInit = (node: Node | null | undefined): RouteGuards | undefined => {
  if (node?.type !== "CallExpression") return undefined;
  const callee = node.callee;
  if (callee.type !== "Identifier" || callee.name !== "withGuards") {
    return undefined;
  }
  const guardsArg = node.arguments?.[1] ?? node.arguments?.[0];
  if (guardsArg == null) return {};
  const result = evaluateConstantNode(guardsArg);
  if (!result.ok || result.value == null || typeof result.value !== "object") {
    return {};
  }
  const v = result.value as Record<string, unknown>;
  const guards: RouteGuards = {};
  if (Array.isArray(v.roles) && v.roles.every((r) => typeof r === "string")) {
    guards.roles = v.roles as string[];
  }
  if (Array.isArray(v.permissions) && v.permissions.every((p) => typeof p === "string")) {
    guards.permissions = v.permissions as string[];
  }
  if (typeof v.all === "boolean") guards.all = v.all;
  if (typeof v.authenticated === "boolean") guards.authenticated = v.authenticated;
  return guards;
};

/**
 * Extract the RBAC guards from a route module's exported handler init
 * (default export or the first named handler binding).
 */
/**
 * Extract guards from the route-local `before` array: `withGuards({...})`
 * calls declared in the schema's `before: [...]` chain. Each element is a
 * `withGuards(guardsObj)` call whose guards object is statically evaluated
 * (literal strings only — `PERMS.X` constants fall back to `{}`, matching
 * the wrapper form). Guards from ALL before entries are merged (any-of
 * within each group), preserving the RBAC compiler optimization for the
 * first-class guard-array form.
 */
interface SchemaProp {
  type?: string;
  key?: { type?: string; name?: string; value?: unknown };
  value?: unknown;
}

/** The property name of an object-literal property node. */
const propName = (p: SchemaProp): string | undefined => {
  const key = p.key;
  if (!key) return undefined;
  return key.type === "Identifier"
    ? key.name
    : key.type === "Literal"
      ? String(key.value)
      : undefined;
};

/** Merge `g` into `acc` (any-of within each group). */
const mergeGuards = (acc: RouteGuards | undefined, g: RouteGuards): RouteGuards => {
  if (!acc) return g;
  return {
    ...(acc.roles?.length || g.roles?.length
      ? { roles: [...(acc.roles ?? []), ...(g.roles ?? [])] }
      : {}),
    ...(acc.permissions?.length || g.permissions?.length
      ? { permissions: [...(acc.permissions ?? []), ...(g.permissions ?? [])] }
      : {}),
    ...(g.all !== undefined ? { all: g.all } : acc.all !== undefined ? { all: acc.all } : {}),
    ...(g.authenticated !== undefined
      ? { authenticated: g.authenticated }
      : acc.authenticated !== undefined
        ? { authenticated: acc.authenticated }
        : {}),
  };
};

const extractGuardsFromBefore = (schemaArg: unknown): RouteGuards | undefined => {
  if (
    !schemaArg ||
    typeof schemaArg !== "object" ||
    (schemaArg as { type?: string }).type !== "ObjectExpression"
  ) {
    return undefined;
  }
  const props = (schemaArg as { properties?: unknown[] }).properties ?? [];
  let merged: RouteGuards | undefined;
  for (const prop of props) {
    if (!prop || typeof prop !== "object") continue;
    const p = prop as SchemaProp;
    if (p.type !== "Property" || propName(p) !== "before") continue;
    if (!p.value || (p.value as { type?: string }).type !== "ArrayExpression") continue;
    const elements = (p.value as { elements?: unknown[] }).elements ?? [];
    for (const el of elements) {
      const g = extractGuardsFromInit(el as never);
      if (g) merged = mergeGuards(merged, g);
    }
  }
  return merged;
};

/** Extract the RBAC guards from a route module's exported handler init
 * (default export or the first named handler binding), including guards
 * declared in the schema's `before` array. */
/** Guards from a handler-init node, including its schema's `before` array. */
const extractGuardsFromInitWithBefore = (init: unknown): RouteGuards | undefined => {
  const wrapperGuards = extractGuardsFromInit(init as never);
  const schemaArg =
    (init as { type?: string })?.type === "CallExpression"
      ? (init as { arguments?: unknown[] }).arguments?.[1]
      : undefined;
  const beforeGuards = extractGuardsFromBefore(schemaArg);
  if (!wrapperGuards) return beforeGuards; // first-class guard-array form
  return mergeGuards(beforeGuards, wrapperGuards);
};

/** Extract the RBAC guards from a route module's exported handler init
 * (default export or the first named handler binding), including guards
 * declared in the schema's `before` array. */
export const extractRouteGuardsAST = (ast: Program): RouteGuards | undefined => {
  let guards: RouteGuards | undefined;
  walk(ast, (n) => {
    if (guards) return;
    if (n.type === "ExportDefaultDeclaration") {
      guards = extractGuardsFromInitWithBefore(n.declaration);
      return;
    }
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (d.init && isHandlerInitNode(d.init)) {
          guards = extractGuardsFromInitWithBefore(d.init);
          return;
        }
      }
    }
  });
  return guards;
};

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
 * True when a node is a handler-shaped initializer: an HTTP wrapper call
 * (`get(...)`, `post(...)`, ...), a bare arrow function, or a function
 * expression. Note this is broader than `extractHandlerFunction`: a wrapper
 * call whose argument is a referenced identifier (`get(myHandler)`) still
 * counts as a handler export even though it cannot be inlined.
 */
export const isHandlerInitNode = (node: Node): boolean =>
  isHandlerWrapperCall(node) ||
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
