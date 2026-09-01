/**
 * @fileoverview Dev-only plugin elimination analysis.
 *
 * `debugbar()` is a development tool. When a build is *production-shaped*, it
 * must not exist in the artifact at all unless the operator explicitly opted
 * back in with `IGNEX_DEBUG=1` at build time: the app-config analysis drops
 * every reachable `debugbar()` from the per-request lifecycle, so routes keep
 * constant-response hoisting and usage-specialized contexts.
 *
 * Eliminated means:
 *   - any `debugbar(...)` call — including `enabled: true` literals and
 *     non-literal `enabled:` expressions — in a **production build**
 *     (`--compile` binary or `NODE_ENV=production` at build time), because
 *     {@link isProductionBuild} is false when `IGNEX_DEBUG=1` opts back in;
 *   - `debugbar({ enabled: false })` — an explicit literal `false` — in any
 *     build;
 *   - the default (env-based) mode in a **production build**.
 *
 * Anything else in a dev-shaped build is treated conservatively as enabled —
 * hooks are kept.
 */

import type { SourceFile } from "../../frontend";
import type {
  ArrayExpression,
  CallExpression,
  Expression,
  ImportSpecifierNode,
  Program,
  SpreadElement,
} from "../../utils/ast/ast-types";
import { propertyName } from "../../utils/ast/ast-types";
import { parseToAst } from "../../utils/ast/parse/bridge";
import { walk } from "../../utils/ast/walk";

/** Result of scanning the app config's `plugins` export. */
export interface DevOnlyPluginAnalysis {
  /** Number of provably-disabled dev-only plugin calls found in the array. */
  readonly eliminated: number;
  /** Number of dev-only plugin calls that are NOT provably disabled. */
  readonly kept: number;
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
 * with no `IGNEX_DEBUG=1` override). A production build eliminates EVERY
 * debugbar instance — options cannot resurrect it; only `IGNEX_DEBUG=1` at
 * build time can (by flipping the production determination itself). In
 * dev-shaped builds, only an explicit literal `enabled: false` is provable.
 */
const debugbarProvablyDisabled = (call: CallExpression, isProductionBuild: boolean): boolean => {
  if (isProductionBuild) return true;
  const arg = unwrap(call.arguments?.[0]);
  if (arg && arg.type === "ObjectExpression") {
    for (const prop of arg.properties ?? []) {
      if (prop.type !== "Property" || prop.kind === "get" || prop.kind === "set") continue;
      if (propertyName(prop.key) !== "enabled") continue;
      const value = unwrap(prop.value);
      // Only a literal `false` is provable; any other expression is unknown.
      return value?.type === "Literal" && value.value === false;
    }
    // No `enabled` key → default (env-based): kept in a dev-shaped build.
    return false;
  }
  // No options argument → default (env-based): kept in a dev-shaped build.
  return false;
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
 * Number of `debugbar(...)` calls reachable under `node` (through spread /
 * conditional / array wrappers, e.g. `...(env.DEBUG ? [debugbar()] : [])`)
 * that are NOT provably disabled for this build. Unlike the top-level
 * `eliminated` count, this descends — a hidden `debugbar()` still enables the
 * lifecycle-stage instrumentation at runtime, so `__TRACE_DEBUG` must stay on
 * unless every reachable call is provably gone.
 */
const countKeptDebugbar = (
  node: Expression | SpreadElement,
  isProductionBuild: boolean,
): number => {
  if (node.type === "SpreadElement") return countKeptDebugbar(node.argument, isProductionBuild);
  const unwrapped = unwrap(node);
  if (unwrapped !== undefined && unwrapped !== node) {
    return countKeptDebugbar(unwrapped, isProductionBuild);
  }
  if (node.type === "ArrayExpression") {
    let n = 0;
    for (const el of node.elements ?? []) {
      if (el) n += countKeptDebugbar(el, isProductionBuild);
    }
    return n;
  }
  if (node.type === "CallExpression") {
    const callee = unwrap(node.callee);
    if (callee?.type === "Identifier" && callee.name === "debugbar") {
      return debugbarProvablyDisabled(node, isProductionBuild) ? 0 : 1;
    }
  }
  // A ternary (`ConditionalExpression`) is outside the typed vocabulary but
  // appears in real configs — recurse into both branches structurally.
  const ternary = node as unknown as {
    type?: string;
    consequent?: unknown;
    alternate?: unknown;
  };
  if (ternary.type === "ConditionalExpression") {
    return (
      (ternary.consequent
        ? countKeptDebugbar(ternary.consequent as Expression, isProductionBuild)
        : 0) +
      (ternary.alternate
        ? countKeptDebugbar(ternary.alternate as Expression, isProductionBuild)
        : 0)
    );
  }
  return 0;
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
  let pluginsArray: ArrayExpression | undefined;
  walk(source.ast, (n) => {
    if (pluginsArray) return false;
    if (n.type !== "ExportNamedDeclaration") return;
    const decl = n.declaration;
    if (decl?.type !== "VariableDeclaration") return;
    const declarator = decl.declarations?.[0];
    if (declarator?.id.type !== "Identifier" || declarator.id.name !== "plugins") {
      return;
    }
    const array = unwrap(declarator.init ?? undefined);
    if (array?.type !== "ArrayExpression") return;
    pluginsArray = array;
    // The plugins export is the only construct this analysis needs — prune.
    return false;
  });

  if (!importsDebugbar) {
    // No debugbar import: nothing to eliminate. Still report whether the
    // `plugins` export is a STATICALLY EMPTY array literal (`export const
    // plugins = []`), which contributes no per-request hooks exactly like an
    // all-disabled list does — apps that keep the export shape but configure
    // no plugins keep their AOT optimizations (constant hoisting, context
    // specialization). Anything non-static (spread, identifiers, missing
    // initializer) stays `totalElements: -1`-style UNKNOWN and is reported as
    // conservative below.
    if (pluginsArray && (pluginsArray.elements ?? []).length === 0) {
      return { eliminated: 0, kept: 0, totalElements: 0 };
    }
    // Unknown/absent shape: report totalElements 1 / eliminated 0 so callers
    // treat the export as ACTIVE (the pre-existing conservative default).
    return { eliminated: 0, kept: 0, totalElements: 1 };
  }

  let eliminated = 0;
  let kept = 0;
  let totalElements = 0;

  const array = pluginsArray;
  if (!array) {
    // debugbar imported but no statically-known plugins array: unknown.
    return { eliminated: 0, kept: 1, totalElements: 1 };
  }
  for (const el of array.elements ?? []) {
    if (!el) continue;
    totalElements += 1;
    // Top-level classification drives the AOT decision (hasActivePlugins):
    // a spread is treated as "unknown plugin" so hooks are conservatively
    // kept. `kept` additionally descends into wrappers so a hidden
    // debugbar still turns on the __TRACE_DEBUG instrumentation.
    if (classifyElement(el, isProductionBuild) === "debugbar-disabled") eliminated += 1;
    kept += countKeptDebugbar(el, isProductionBuild);
  }

  return { eliminated, kept, totalElements };
};

/**
 * Statically decide whether the app config's `lifecycle` / `hooks` export
 * contributes any per-request hooks.
 *
 * Returns `false` (no hooks) only when the export's initializer is PROVABLY
 * empty: an object literal with zero properties, or one whose every property
 * is an empty array literal (`{ beforeHandle: [] }`). Anything else —
 * spreads, identifiers, function values, non-empty arrays, computed keys,
 * unknown shapes — yields `true` (conservative: assume hooks exist).
 */
export const lifecycleExportIsStaticallyEmpty = (source: SourceFile): boolean => {
  let init: Expression | undefined;
  let found = false;

  walk(source.ast, (n) => {
    if (found) return false;
    if (n.type !== "ExportNamedDeclaration") return;
    const decl = n.declaration;
    if (decl?.type !== "VariableDeclaration") return;
    const declarator = decl.declarations?.[0];
    if (declarator?.id.type !== "Identifier") return;
    if (declarator.id.name !== "lifecycle" && declarator.id.name !== "hooks") return;
    init = unwrap(declarator.init ?? undefined);
    found = true;
    return false;
  });

  if (!found) return true; // no such export → trivially hook-free
  if (!init) return true; // `export const lifecycle;` — nothing registered
  if (init.type !== "ObjectExpression") return false; // unknown shape

  const props = init.properties ?? [];
  for (const p of props) {
    if (p.type !== "Property" || p.computed || p.kind !== "init") return false;
    const value = unwrap(p.value);
    if (value?.type !== "ArrayExpression") return false;
    if ((value.elements ?? []).length > 0) return false;
  }
  return true;
};

// ============================================================================
// Production artifact slimming: neutralize the `debugbar` import bindings
// ============================================================================

/** A `debugbar` import specifier to replace with the inert stub. */
export interface DebugbarImportBinding {
  /** The LOCAL name the app config binds (`debugbar`, or an alias target). */
  readonly local: string;
  /** Byte offsets of the specifier node within the source. */
  readonly start: number;
  readonly end: number;
}

/** The name a named-import specifier binds from the module (`x` / `"x"`). */
const importedSpecifierName = (
  spec: Extract<ImportSpecifierNode, { type: "ImportSpecifier" }>,
): string | undefined => {
  const imported = spec.imported;
  if (imported === undefined) return spec.local.name;
  return imported.type === "Identifier" ? imported.name : String(imported.value);
};

/** First/last byte offset of any AST node (mirrors walk.ts nodeStart/nodeEnd). */
const posStart = (n: {
  start?: number;
  range?: [number, number];
  span?: [number, number];
}): number | undefined => n.range?.[0] ?? n.start ?? n.span?.[0];
const posEnd = (n: {
  end?: number;
  range?: [number, number];
  span?: [number, number];
}): number | undefined => n.range?.[1] ?? n.end ?? n.span?.[1];

/**
 * Locate every `debugbar` (or aliased) named-import specifier bound from
 * {@link DEBUGBAR_IMPORT_SOURCES}, with byte offsets for surgical removal.
 * Namespace/default imports are skipped — those call shapes were never
 * provably classifiable, so they never reach elimination.
 */
export const findDebugbarImportBindings = (ast: Program): DebugbarImportBinding[] => {
  const out: DebugbarImportBinding[] = [];
  walk(ast, (n) => {
    if (n.type !== "ImportDeclaration") return;
    const sourceValue = n.source?.value;
    if (typeof sourceValue !== "string" || !DEBUGBAR_IMPORT_SOURCES.has(sourceValue)) {
      return;
    }
    for (const spec of n.specifiers ?? []) {
      if (spec.type !== "ImportSpecifier") continue;
      if (importedSpecifierName(spec) !== "debugbar") continue;
      const start = posStart(spec);
      const end = posEnd(spec);
      if (start === undefined || end === undefined) continue;
      out.push({ local: spec.local.name, start, end });
    }
  });
  return out;
};

/**
 * Rewrite an app-config module for a production-shaped build so the inert
 * dev-only plugin no longer pulls `@ignex/core`'s debug graph into the
 * bundle: every `debugbar` specifier is removed from the import and rebound
 * to a local factory returning exactly what the prod-locked plugin would
 * (`{ name: "debugbar", __ignexDevOnly: true }`). The bundler then treeshakes
 * the dashboard SPA, observatory endpoints and TraceStore (~MBs) out of the
 * artifact.
 *
 * Returns `null` when there is nothing to rewrite (no static debugbar
 * import). Only called for production shapes — `IGNEX_DEBUG=1` flips the
 * shape back to dev and keeps the real plugin wired in.
 */
export const debugbarStubRewrite = (contents: string): string | null => {
  let ast: Program;
  try {
    ast = parseToAst(contents);
  } catch {
    return null;
  }

  const bindings = findDebugbarImportBindings(ast);
  if (bindings.length === 0) return null;

  // Splice specifiers out (descending offsets keep earlier ranges valid),
  // cleaning the adjacent comma so `{ a, debugbar }` / `{ debugbar, b }` /
  // `{ debugbar }` all end syntactically valid. `import {} from …` is legal.
  let out = contents;
  for (const binding of [...bindings].sort((a, b) => b.start - a.start)) {
    let { start, end } = binding;
    if (out[end] === ",") end += 1;
    else if (out[start - 1] === ",") start -= 1;
    out = out.slice(0, start) + out.slice(end);
  }

  // Imports hoist above statements, so prepending the stub declarations is
  // order-safe: the bindings initialize before any plugins-array initializer
  // runs, under the same names the rest of the module references.
  const locals = [...new Set(bindings.map((b) => b.local))];
  const stub = locals
    .map((local) => `const ${local} = () => ({ name: "debugbar", __ignexDevOnly: true });`)
    .join("\n");
  return `${stub}\n${out}`;
};
