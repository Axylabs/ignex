/**
 * @fileoverview AST-based response-type inference.
 *
 * Heuristically classifies a handler's output as JSON / text / HTML / stream
 * based on which `ctx.*` reply helper it calls, falling back to `unknown`.
 * This only matters for pure AST detection — the `usage` bitmap already wins
 * when the corresponding flag is set.
 */

import type { Node } from "./ast-types";
import { flattenMember } from "./purity";
import { walk } from "./walk";

export type InferredResponseType = "json" | "text" | "html" | "stream" | "unknown";

/** Infer the response type from a module (or handler) AST. */
export function inferResponseTypeAST(ast: Node): InferredResponseType {
  let type: InferredResponseType = "unknown";

  walk(ast, (n) => {
    if (n.type === "CallExpression" && n.callee?.type === "MemberExpression") {
      const chain = flattenMember(n.callee);
      if (chain === "ctx.json") type = "json";
      else if (chain === "ctx.text") type = "text";
      else if (chain === "ctx.html") type = "html";
      else if (chain === "ctx.stream") type = "stream";
    }
    // Heuristic: `return "string"` or a template literal → text.
    if (
      type === "unknown" &&
      n.type === "ReturnStatement" &&
      n.argument?.type === "Literal" &&
      typeof n.argument.value === "string"
    ) {
      type = "text";
    }
  });

  return type;
}
