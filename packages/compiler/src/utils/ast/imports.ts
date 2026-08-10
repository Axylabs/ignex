/**
 * @fileoverview AST-based import / export extraction.
 *
 * Replaces regex-based extraction with a lightweight ESTree walk. Handles
 * default / namespace / named specifiers, declaration exports, re-export
 * specifiers, and answers the "does this module have a default export?"
 * question used throughout the route pipeline.
 */

import type { ExportInfo, ImportInfo } from "../../types";
import { bindingName, type Program } from "./ast-types";
import { walk, walkUntil } from "./walk";

/**
 * Build ImportInfo without assigning explicit undefined properties.
 * Satisfies `exactOptionalPropertyTypes` cleanly.
 */
export const createImportInfo = (
  source: string,
  names: string[],
  defaultName?: string,
  namespaceName?: string,
): ImportInfo => {
  const info: {
    source: string;
    names: string[];
    defaultName?: string;
    namespaceName?: string;
  } = {
    source,
    names,
  };

  if (defaultName !== undefined) info.defaultName = defaultName;
  if (namespaceName !== undefined) info.namespaceName = namespaceName;

  return info;
};

/** Extract every `import` statement in the module. */
export function extractImportsAST(ast: Program): ImportInfo[] {
  const imports: ImportInfo[] = [];

  walk(ast, (n) => {
    if (n.type !== "ImportDeclaration") return;
    const source = n.source?.value;
    if (typeof source !== "string" || source.length === 0) return;

    const names: string[] = [];
    let defaultName: string | undefined;
    let namespaceName: string | undefined;

    for (const spec of n.specifiers || []) {
      if (spec.type === "ImportDefaultSpecifier") defaultName = spec.local?.name;
      if (spec.type === "ImportNamespaceSpecifier") namespaceName = spec.local?.name;
      if (spec.type === "ImportSpecifier") {
        const local = spec.local?.name;
        if (local) names.push(local);
      }
    }

    imports.push(createImportInfo(source, names, defaultName, namespaceName));
  });

  return imports;
}

/** Extract every export in the module (default + named declarations/specifiers). */
export function extractExportsAST(ast: Program): ExportInfo[] {
  const exports: ExportInfo[] = [];
  walk(ast, (n) => {
    if (n.type === "ExportDefaultDeclaration") {
      // Only a bare identifier default (`export default root`) names the
      // binding after that identifier; function/class/expression defaults
      // are exported under the `"default"` name regardless of `id.name`.
      const name = n.declaration?.type === "Identifier" ? n.declaration.name : "default";
      exports.push({ name, kind: "default" });
    }
    if (n.type === "ExportNamedDeclaration") {
      // Re-export specifiers: `export { foo as bar }`
      for (const spec of n.specifiers || []) {
        if (spec.type === "ExportSpecifier") {
          exports.push({ name: spec.local?.name ?? "", kind: "named" });
        }
        if (spec.type === "ExportNamespaceSpecifier") {
          exports.push({ name: spec.exported?.name ?? "*", kind: "namespace" });
        }
      }
      // Declaration exports: `export const x = …`, `export function f(){}`
      if (n.declaration) {
        if (n.declaration.type === "FunctionDeclaration") {
          if (n.declaration.id?.name) exports.push({ name: n.declaration.id.name, kind: "named" });
        } else if (n.declaration.type === "VariableDeclaration") {
          const id = n.declaration.declarations?.[0]?.id;
          const name = bindingName(id);
          if (name) exports.push({ name, kind: "named" });
        }
        if (n.declaration.type === "ClassDeclaration" && n.declaration.id?.name) {
          exports.push({ name: n.declaration.id.name, kind: "named" });
        }
      }
    }
    // All-exports: `export * from "x"` / `export * as ns from "x"`
    if (n.type === "ExportAllDeclaration") {
      exports.push({ name: n.exported?.name ?? "*", kind: "namespace" });
    }
  });
  return exports;
}

/** True when the module has a default export (early-terminating search). */
export function hasDefaultExportAST(ast: Program): boolean {
  return walkUntil(ast, (n) => (n.type === "ExportDefaultDeclaration" ? true : undefined)) ?? false;
}
