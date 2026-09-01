/**
 * @fileoverview Export classification — single-pass, early-terminating scan.
 *
 * Resolves every route-module classification flag (default/handler/schema/
 * config exports) in one walk that stops as soon as all flags are decided.
 */

import {
  bindingName,
  type ExportDefaultDeclaration,
  type ExportNamedDeclaration,
  type ExportNamespaceSpecifier,
  type ExportSpecifier,
  type Node,
  type Program,
  type VariableDeclarator,
} from "../ast-types";
import { HTTP_WRAPPERS, isHandlerInitNode } from "../handler";
import { walk, walkSome } from "../walk";

/** Whether a schema argument is "real" (not a string literal placeholder). */
const isSchemaArg = (arg: Node | null | undefined): boolean =>
  !!arg && arg.type !== "Literal" && arg.type !== "StringLiteral" && arg.type !== "TemplateLiteral";

/** True when a schema object literal declares `before`/`after` keys. */
const schemaHasLocalHooks = (node: {
  type: string;
  properties?: Array<{ type: string; key?: { type: string; name?: string; value?: unknown } }>;
}): boolean => {
  for (const prop of node.properties ?? []) {
    if (prop.type !== "Property") continue;
    const key = prop.key;
    if (!key) continue;
    const name =
      key.type === "Identifier" ? key.name : key.type === "Literal" ? String(key.value) : undefined;
    if (name === "before" || name === "after") return true;
  }
  return false;
};

/** True when a named export initializer is a schema-first HTTP wrapper call. */
const hasSchemaSecondArg = (init: Node | null | undefined): boolean => {
  if (
    init?.type === "CallExpression" &&
    init.callee?.type === "Identifier" &&
    isHandlerInitNode(init) // wrapper call (get/post/…)
  ) {
    return isSchemaArg(init.arguments?.[1]);
  }
  return false;
};

/** True when a node exports a `schema` binding (named or re-exported). */
const isSchemaNamedExport = (n: Node): boolean => {
  if (n.type === "ExportSpecifier" && n.local?.name === "schema") return true;
  if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
    for (const d of n.declaration.declarations || []) {
      if (bindingName(d.id) === "schema") return true;
      if (bindingName(d.id) && hasSchemaSecondArg(d.init)) return true;
    }
  }
  return false;
};

/** True when a node is a schema-first HTTP default export. */
const isSchemaDefaultExport = (n: Node): boolean => {
  if (
    n.type === "ExportDefaultDeclaration" &&
    n.declaration?.type === "CallExpression" &&
    n.declaration.callee?.type === "Identifier" &&
    isHandlerInitNode(n.declaration)
  ) {
    return isSchemaArg(n.declaration.arguments?.[1]);
  }
  return false;
};

/**
 * True when the module exports a `schema` binding (named export or
 * schema-first HTTP wrapper with a non-literal second argument).
 * Kept exported for API compatibility; `scanExportFlags` is the fast path.
 */
export function hasSchemaExportAST(ast: Program): boolean {
  let found = false;
  walk(ast, (n) => {
    if (found) return;
    if (isSchemaNamedExport(n) || isSchemaDefaultExport(n)) found = true;
  });
  return found;
}

/** True when the module exports a `config` binding. */
export function hasConfigExportAST(ast: Program): boolean {
  let found = false;
  walk(ast, (n) => {
    if (found) return;
    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (bindingName(d.id) === "config") found = true;
      }
    }
    if (n.type === "ExportSpecifier" && n.local?.name === "config") found = true;
  });
  return found;
}

interface ExportFlags {
  hasDefaultExport: boolean;
  hasHandlerExport: boolean;
  schemaExport: boolean;
  configExport: boolean;
  /** Default export is a wrapper call (may attach route-local hooks). */
  wrappedHandler: boolean;
  /** The route schema declares route-local `before`/`after` chains. */
  localHooks: boolean;
}

/** Apply a default export's contribution to the classification flags. */
const applyDefaultExport = (
  decl: ExportDefaultDeclaration["declaration"],
  flags: ExportFlags,
): void => {
  flags.hasDefaultExport = true;
  // Matches `hasHandlerExportAST`: a default export makes a module a route
  // module (route files are expected to default-export a handler).
  flags.hasHandlerExport = true;
  // Schema-first HTTP: `export default get(handler, { … })`.
  if (decl?.type === "CallExpression" && isHandlerInitNode(decl)) {
    if (isSchemaArg(decl.arguments?.[1])) flags.schemaExport = true;
    // A wrapper call (`withGuards(...)`, not an HTTP helper) may attach
    // route-local hooks at runtime — record it for codegen + hoist gating.
    const callee = decl.callee?.type === "Identifier" ? decl.callee.name : "";
    if (!HTTP_WRAPPERS.has(callee)) flags.wrappedHandler = true;
    // Route-local before/after declared in the schema object (the
    // first-class guard array) — drives the compiled hook chain.
    const schemaArg = decl.arguments?.[1];
    if (schemaArg?.type === "ObjectExpression" && schemaHasLocalHooks(schemaArg)) {
      flags.localHooks = true;
    }
  }
};

/** Apply a variable-declaration export's contribution to the flags. */
const applyVariableDeclarations = (
  declarations: readonly VariableDeclarator[] | undefined,
  flags: ExportFlags,
): void => {
  for (const d of declarations || []) {
    const name = bindingName(d.id);
    const init = d.init;
    if (!name || !init) continue;
    if (name === "schema") flags.schemaExport = true;
    if (name === "config") flags.configExport = true;
    if (isHandlerInitNode(init)) flags.hasHandlerExport = true;
    if (hasSchemaSecondArg(init)) flags.schemaExport = true;
  }
};

/** Apply re-export specifiers' contribution to the flags. */
const applyNamedSpecifiers = (
  specifiers: readonly (ExportSpecifier | ExportNamespaceSpecifier)[] | undefined,
  flags: ExportFlags,
): void => {
  for (const spec of specifiers || []) {
    const local = spec.type === "ExportSpecifier" ? spec.local?.name : undefined;
    if (local === "schema") flags.schemaExport = true;
    if (local === "config") flags.configExport = true;
  }
};

/** Apply a named export's contribution to the classification flags. */
const applyNamedExport = (n: ExportNamedDeclaration, flags: ExportFlags): void => {
  if (n.declaration?.type === "VariableDeclaration") {
    applyVariableDeclarations(n.declaration.declarations, flags);
  } else if (n.declaration?.type === "FunctionDeclaration") {
    flags.hasHandlerExport = true;
  }
  applyNamedSpecifiers(n.specifiers, flags);
};

/**
 * Resolve every route-module classification flag in a single early-terminating
 * walk. `walkSome` stops the instant all four flags are decided, so modules
 * that export everything (or nothing) are classified after a partial walk.
 */
export const scanExportFlags = (ast: Program): ExportFlags => {
  const flags: ExportFlags = {
    hasDefaultExport: false,
    hasHandlerExport: false,
    schemaExport: false,
    configExport: false,
    wrappedHandler: false,
    localHooks: false,
  };

  const done = (): boolean =>
    flags.hasDefaultExport && flags.hasHandlerExport && flags.schemaExport && flags.configExport;

  walkSome(ast, (n) => {
    if (n.type === "ExportDefaultDeclaration") applyDefaultExport(n.declaration, flags);
    if (n.type === "ExportNamedDeclaration") applyNamedExport(n, flags);
    return done();
  });

  return flags;
};
