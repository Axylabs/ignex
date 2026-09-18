/**
 * @fileoverview Statically-read `contextUsage` declarations from user plugin
 * modules (WS2).
 *
 * The compiler cannot execute plugin factories, so the ONLY auditable form of
 * a user plugin's context declaration is a statically-parseable module export:
 *
 * ```ts
 * export const contextUsage = { headers: true, method: true };
 * ```
 *
 * This reader resolves the plugin module, parses it through the build's
 * {@link SourceManager}, and translates the literal into a {@link ContextUsage}.
 * It is deliberately conservative — ANYTHING it cannot fully establish
 * (unresolvable module, dynamic initializer, unknown member, non-`true` value,
 * duplicate declarations) returns `null`, and the caller treats that as
 * "plugin layer is opaque" → full context. It never returns a partial usage.
 */

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { type ContextUsage, EMPTY_USAGE } from "@ignex/shared";
import type { SourceManager } from "../../frontend";
import {
  type Expression,
  type ObjectExpression,
  type Program,
  propertyName,
} from "../../utils/ast/ast-types";
import { walk } from "../../utils/ast/walk";

/** Every member a declaration may set — mirrors `keyof ContextUsage`. */
const KNOWN_USAGE_KEYS: ReadonlySet<string> = new Set(Object.keys(EMPTY_USAGE));

/**
 * Module extensions probed for a RELATIVE specifier when standard resolution
 * fails. The standard path (createRequire) already resolves extensionless
 * `.ts` under Bun; the probe covers harnesses where `createRequire` behaves
 * like Node's resolver (e.g. the vitest/vite-node module runner).
 */
const RELATIVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".mjs", ".cjs"];

/** A `ContextUsage` with every field writable, for accumulation. */
type MutableUsage = { -readonly [K in keyof ContextUsage]: boolean };

/**
 * Resolve `spec` to an absolute module path relative to `fromPath`, or `null`.
 *
 * Standard module resolution first (Bun's `createRequire` resolves
 * extensionless `.ts`; it also handles packages and explicit extensions).
 * When that fails, RELATIVE specifiers (`./`, `../`) are probed manually with
 * the usual extensions and `index` files — enough to cover test harnesses
 * whose `node:module` is not Bun's TS-aware copy.
 */
const resolveModulePath = (spec: string, fromPath: string): string | null => {
  try {
    return createRequire(fromPath).resolve(spec);
  } catch {
    // Fall through to manual probing for relative specifiers.
  }
  if (!spec.startsWith("./") && !spec.startsWith("../")) return null;

  const base = resolve(dirname(fromPath), spec);
  for (const ext of RELATIVE_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of RELATIVE_EXTENSIONS) {
    if (existsSync(join(base, `index${ext}`))) return join(base, `index${ext}`);
  }
  return null;
};

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

/** True when `e` unwraps to a literal node with value exactly `true`. */
const isLiteralTrue = (e: Expression | undefined): boolean => {
  const node = unwrap(e);
  if (!node) return false;
  switch (node.type) {
    case "Literal":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      return node.value === true;
    default:
      return false;
  }
};

/**
 * Translate `export const contextUsage = { …literal… }` into a usage record.
 *
 * @param ast - The resolved plugin module's retained AST.
 * @returns The declared usage (undeclared members false, frozen), or `null`
 * when the declaration is missing, duplicated, non-literal, carries an
 * unknown member, or any member value is not literal `true`.
 */
const readContextUsageFromAst = (ast: Program): Readonly<ContextUsage> | null => {
  let literal: ObjectExpression | null = null;
  let seen = 0;

  walk(ast, (n) => {
    if (n.type !== "ExportNamedDeclaration") return;
    const decl = n.declaration;
    if (decl?.type !== "VariableDeclaration") return;
    for (const declarator of decl.declarations) {
      if (declarator.id.type !== "Identifier" || declarator.id.name !== "contextUsage") continue;
      seen += 1;
      const init = unwrap(declarator.init ?? undefined);
      if (init?.type === "ObjectExpression") literal = init;
    }
  });

  // Missing, duplicated, or non-literal → opaque — never a partial usage.
  if (seen !== 1 || literal === null) return null;

  const usage: MutableUsage = { ...EMPTY_USAGE };
  for (const prop of literal.properties ?? []) {
    // Spreads / methods / accessors are not statically-parseable declarations.
    if (prop.type !== "Property" || prop.kind === "get" || prop.kind === "set" || prop.method) {
      return null;
    }
    const key = propertyName(prop.key);
    if (typeof key !== "string" || !KNOWN_USAGE_KEYS.has(key)) return null;
    if (!isLiteralTrue(prop.value)) return null;
    usage[key as keyof ContextUsage] = true;
  }

  return Object.freeze(usage);
};

/**
 * Resolve `spec` (an import specifier, e.g. `"./auth"`) relative to `fromPath`
 * (the importing module's absolute path) and return the plugin module's
 * declared context usage.
 *
 * Resolves through Node's standard module resolution via `createRequire`
 * (Bun-aware: `.ts` extensions, `index` files, packages). Unresolvable
 * modules and unparseable files return `null`.
 *
 * @param sources - The build's source manager (idempotent per path — a
 * module already parsed as a route file is reused, not re-parsed).
 * @param spec - The raw import specifier from the app config's `import`.
 * @param fromPath - Absolute path of the importing module (the app config).
 * @returns The declared usage, or `null` when it cannot be fully established.
 */
export const readDeclaredContextUsage = (
  sources: SourceManager,
  spec: string,
  fromPath: string,
): Readonly<ContextUsage> | null => {
  const absPath = resolveModulePath(spec, fromPath);
  if (!absPath) {
    // Unresolvable — treat the plugin layer as opaque.
    return null;
  }
  const file = sources.read(absPath, absPath);
  if (!file) return null;
  return readContextUsageFromAst(file.ast);
};
