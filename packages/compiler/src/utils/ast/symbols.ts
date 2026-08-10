/**
 * @fileoverview AST-based symbol extraction.
 *
 * Enumerates module-level functions and `const fn = () => …` bindings and
 * builds a lightweight intra-module call graph (`calls` / `calledBy`), plus
 * the `size` and `hotness` (caller count) metadata used by the optimizer's
 * inline eligibility and deduplication decisions.
 */

import type { Position, SymbolInfo, SymbolKind } from "../../types";
import { bindingName, type FunctionNode, type Node, type Program } from "./ast-types";
import { nodeEnd, nodeStart, walk } from "./walk";

/** Fallback when a parser does not emit offsets for a node. */
const DEFAULT_NODE_SIZE = 9999;

function posFromNode(node: Node): Position {
  if (node.loc?.start) return { line: node.loc.start.line, column: node.loc.start.column };
  // Fall back to a safe sentinel rather than fabricate a position.
  return { line: 1, column: 0 };
}

interface SymbolDef {
  name: string;
  kind: SymbolKind;
  node: FunctionNode;
  isAsync: boolean;
}

const nodeSize = (node: Node): number => {
  const start = nodeStart(node);
  const end = nodeEnd(node);
  if (start == null || end == null) return DEFAULT_NODE_SIZE;
  return Math.max(0, end - start);
};

/** Extract module symbols with a lightweight intra-module call graph. */
export function extractSymbolsAST(_source: string, ast: Program): SymbolInfo[] {
  const defs = new Map<string, SymbolDef>();

  walk(ast, (n) => {
    if (n.type === "FunctionDeclaration" && n.id?.name) {
      defs.set(n.id.name, {
        name: n.id.name,
        kind: "function",
        node: n,
        isAsync: n.async ?? false,
      });
    }
    if (n.type === "VariableDeclaration") {
      for (const decl of n.declarations || []) {
        const name = bindingName(decl.id);
        if (name && decl.init?.type === "ArrowFunctionExpression") {
          defs.set(name, {
            name,
            kind: "const",
            node: decl.init,
            isAsync: decl.init.async ?? false,
          });
        }
      }
    }
  });

  // Per-symbol calls to other module symbols.
  const callsMap = new Map<string, string[]>();
  for (const [name, def] of defs) {
    const calls = new Set<string>();
    walk(def.node, (n) => {
      if (n.type === "CallExpression" && n.callee?.type === "Identifier") {
        const callee = n.callee.name;
        if (callee !== name && defs.has(callee)) calls.add(callee);
      }
    });
    callsMap.set(name, [...calls]);
  }

  // Reverse index (callers per symbol).
  const calledBy = new Map<string, string[]>();
  for (const [name, calls] of callsMap) {
    for (const callee of calls) {
      const list = calledBy.get(callee);
      if (list) list.push(name);
      else calledBy.set(callee, [name]);
    }
  }

  const symbols: SymbolInfo[] = [];
  for (const [name, def] of defs) {
    const calls = callsMap.get(name) ?? [];
    const callers = calledBy.get(name) ?? [];

    symbols.push({
      name,
      kind: def.kind,
      pos: posFromNode(def.node),
      isAsync: def.isAsync,
      isDefaultExport: false,
      params: (def.node.params || []).map((p) => bindingName(p) ?? "..."),
      decorators: [],
      calls,
      calledBy: callers,
      size: nodeSize(def.node),
      hotness: callers.length,
    });
  }

  return symbols;
}
