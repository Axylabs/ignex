/**
 * @fileoverview AST-based response-type inference.
 *
 * Heuristically classifies a handler's output as JSON / text / HTML / stream
 * based on which `ctx.*` reply helper it calls, falling back to `unknown`.
 * This only matters for pure AST detection — the `usage` bitmap already wins
 * when the corresponding flag is set.
 *
 * Also hosts {@link findResponseJsonReturn}, the compile-time guard that
 * flags handlers returning `Response.json(...)` directly so they can be
 * steered to the AOT-optimizable `ctx.json(...)` / plain-value forms.
 */

import type { CallExpression, FunctionNode, Node } from "./ast-types";
import { extractHandlerNodeAST } from "./handler";
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

/** Unwrap parens / TS type wrappers to reach the underlying expression. */
const unwrapExpression = (node: Node): Node => {
  let current = node;
  while (
    current.type === "ParenthesizedExpression" ||
    current.type === "TSAsExpression" ||
    current.type === "TSTypeAssertion" ||
    current.type === "TSNonNullExpression"
  ) {
    const inner = (current as { expression?: Node }).expression;
    if (!inner) break;
    current = inner;
  }
  return current;
};

/** True when `node` is a direct `Response.json(...)` call. */
export const isResponseJsonCall = (node: Node): node is CallExpression =>
  node.type === "CallExpression" &&
  node.callee?.type === "MemberExpression" &&
  node.callee.object?.type === "Identifier" &&
  node.callee.object.name === "Response" &&
  !node.callee.computed &&
  node.callee.property?.type === "Identifier" &&
  node.callee.property.name === "json";

/**
 * Find a handler's direct `return Response.json(...)` (or expression-bodied
 * `() => Response.json(...)`). Returns the call node (for position info) or
 * `null`.
 *
 * Only DIRECT returns are flagged. `Response.json` nested inside another call
 * (e.g. `withBrowserCache(Response.json(...))`) legitimately needs a `Response`
 * and is left alone, avoiding false positives.
 */
/** Narrow an arbitrary node to a function node (or `null`). */
const toFunctionNode = (node: Node): FunctionNode | null =>
  node.type === "ArrowFunctionExpression" ||
  node.type === "FunctionExpression" ||
  node.type === "FunctionDeclaration"
    ? node
    : null;

export const findResponseJsonReturn = (ast: Node): CallExpression | null => {
  const fn: FunctionNode | null =
    ast.type === "Program" ? extractHandlerNodeAST(ast) : toFunctionNode(ast);
  if (!fn) return null;

  // Expression-bodied arrow: `() => Response.json(...)`.
  if (fn.body.type !== "BlockStatement") {
    const expr = unwrapExpression(fn.body);
    return isResponseJsonCall(expr) ? expr : null;
  }

  // Block-bodied: find a direct `return Response.json(...)`.
  let found: CallExpression | null = null;
  walk(fn.body, (n) => {
    if (found) return;
    if (n.type !== "ReturnStatement" || !n.argument) return;
    const expr = unwrapExpression(n.argument);
    if (isResponseJsonCall(expr)) found = expr;
  });
  return found;
};
