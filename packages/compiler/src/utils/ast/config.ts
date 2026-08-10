/**
 * @fileoverview Route `config` export extraction.
 *
 * Route files may export a `config` object (cache TTL, hooks, …). Because we
 * never `eval` user source, the initializer must be a statically-evaluable
 * constant; otherwise a warning is emitted and the config is ignored.
 */

import { DiagnosticCodes, type DiagnosticCollector, getCodeFrame } from "../../diagnostics";
import { bindingName, type Program, type VariableDeclarator } from "./ast-types";
import { evaluateConstantNode } from "./constant";
import { nodeEnd, nodeStart, walk } from "./walk";

/**
 * Extract and statically evaluate a module's `config` export.
 * Returns the evaluated value, or `undefined` when absent / non-constant
 * (with a warning when the initializer was present but not evaluable).
 */
export function extractRouteConfigAST(
  source: string,
  ast: Program,
  diagnostics?: DiagnosticCollector,
): unknown | undefined {
  let configDecl: VariableDeclarator | undefined;

  walk(ast, (n) => {
    if (configDecl) return;

    if (n.type === "ExportNamedDeclaration" && n.declaration?.type === "VariableDeclaration") {
      for (const d of n.declaration.declarations || []) {
        if (bindingName(d.id) === "config" && d.init) {
          configDecl = d;
        }
      }
    }
  });

  if (!configDecl?.init) return undefined;

  const result = evaluateConstantNode(configDecl.init);
  if (result.ok) return result.value;

  const start = nodeStart(configDecl.init);
  const end = nodeEnd(configDecl.init);

  diagnostics?.warn({
    code: DiagnosticCodes.ConfigEvalFailed,
    message: "Route `config` export is not a statically-evaluable constant and was ignored.",
    frame:
      start != null && end != null
        ? getCodeFrame(source.slice(0, end), { line: 1, column: start })
        : undefined,
  });

  return undefined;
}
