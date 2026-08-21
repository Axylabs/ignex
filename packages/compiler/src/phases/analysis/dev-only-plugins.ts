/**
 * @fileoverview Dev-only plugin elimination analysis.
 *
 * `debugbar()` is a development tool. When it is *provably disabled* for the
 * build it is registered in, it must not cost the production artifact
 * anything: the app-config analysis uses this to drop its per-request
 * lifecycle contribution, so routes regain constant-response hoisting and
 * usage-specialized contexts (`needsFull` stays off).
 *
 * Provably disabled means:
 *   - `debugbar({ enabled: false })` — an explicit literal `false`, or
 *   - the default (env-based) mode in a **production build** — the compiler
 *     bakes `NODE_ENV=production` for `--compile` binaries and honors
 *     `NODE_ENV=production` at build time (unless `IGNEX_DEBUG=1` is set at
 *     build time, which would re-enable it at runtime).
 *
 * Anything else (`enabled: true`, a non-literal expression, an aliased
 * import) is treated conservatively as enabled — hooks are kept.
 */

import type { SourceFile } from "../../frontend";
import type { CallExpression, Expression, SpreadElement } from "../../utils/ast/ast-types";
import { propertyName } from "../../utils/ast/ast-types";
import { walk } from "../../utils/ast/walk";

/** Result of scanning the app config's `plugins` export. */
export interface DevOnlyPluginAnalysis {
  /** Number of provably-disabled dev-only plugin calls found in the array. */
  readonly eliminated: number;
  /** Total array elements (including spreads / non-debugbar plugins). */
  readonly totalElements: number;
}

/** Sources the `debugbar` plugin may be imported from. */
const DEBUGBAR_IMPORT_SOURCES = new Set(["@ignex/core", "@ignex/core/index"]);

/** Unwrap TS expression wrappers (`as`, `!`, `<T>`, parens). */
const unwrap = (e: Expression | undefined): Expression | undefined => {
  let node = e;
  while (
    node &&
    (node.type === "TSAsExpression" ||
      node.type === "TSTypeAssertion" ||
      node.type === "TSNonNullExpression" ||
      node.type === "ParenthesizedExpression")
  ) {
    node = node.expression;
  }
  return node;
};

/**
 * True when this `debugbar(...)` call is provably disabled for the build.
 *
 * `isProductionBuild` is the compiler's determination that the artifact is
 * production-shaped (`--compile`, or `NODE_ENV=production` at build time,
 * with no `IGNEX_DEBUG=1` override).
 */
const debugbarProvablyDisabled = (call: CallExpression, isProductionBuild: boolean): boolean => {
  const arg = unwrap(call.arguments?.[0]);
  if (arg && arg.type === "ObjectExpression") {
    for (const prop of arg.properties ?? []) {
      if (prop.type !== "Property" || prop.kind === "get" || prop.kind === "set") continue;
      if (propertyName(prop.key) !== "enabled") continue;
      const value = unwrap(prop.value);
      // Only a literal `false` is provable; any other expression is unknown.
      return value?.type === "Literal" && value.value === false;
    }
    // No `enabled` key → default (env-based): disabled in production builds.
    return isProductionBuild;
  }
  // No options argument → default (env-based): disabled in production builds.
  return isProductionBuild;
};

/**
 * Classify one `plugins` array element: is it a `debugbar(...)` call, and is
 * that call provably disabled for this build?
 */
const classifyElement = (
  el: Expression | SpreadElement,
  isProductionBuild: boolean,
): "debugbar-disabled" | "debugbar-enabled" | "other" => {
  if (el.type !== "CallExpression") return "other";
  const callee = unwrap(el.callee);
  if (callee?.type !== "Identifier" || callee.name !== "debugbar") return "other";
  return debugbarProvablyDisabled(el, isProductionBuild) ? "debugbar-disabled" : "debugbar-enabled";
};

/**
 * Scan the app config's `plugins` export for dev-only plugin calls that are
 * provably disabled, so the compiler can restore AOT optimizations they would
 * otherwise force off.
 */
export const analyzeDevOnlyPlugins = (
  source: SourceFile,
  isProductionBuild: boolean,
): DevOnlyPluginAnalysis => {
  // Only proceed when `debugbar` was imported from @ignex/core (by its own
  // name — aliased imports are treated conservatively and never eliminated).
  let importsDebugbar = false;
  for (const imp of source.imports) {
    if (!DEBUGBAR_IMPORT_SOURCES.has(imp.source)) continue;
    if (imp.names.includes("debugbar")) {
      importsDebugbar = true;
      break;
    }
  }
  if (!importsDebugbar) return { eliminated: 0, totalElements: 0 };

  let eliminated = 0;
  let totalElements = 0;
  walk(source.ast, (n) => {
    if (n.type !== "ExportNamedDeclaration") return;
    const decl = n.declaration;
    if (decl?.type !== "VariableDeclaration") return;
    const declarator = decl.declarations?.[0];
    if (!declarator || declarator.id.type !== "Identifier" || declarator.id.name !== "plugins") {
      return;
    }
    const array = unwrap(declarator.init ?? undefined);
    if (array?.type !== "ArrayExpression") return;
    for (const el of array.elements ?? []) {
      if (!el) continue;
      totalElements += 1;
      if (classifyElement(el, isProductionBuild) === "debugbar-disabled") eliminated += 1;
    }
    // The plugins export is the only construct this analysis needs — prune.
    return false;
  });

  return { eliminated, totalElements };
};
