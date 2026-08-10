/**
 * @fileoverview Safe, side-effect-free constant evaluation.
 *
 * Replaces `new Function(...)` — the compiler never evaluates user source at
 * build time. Only a small, closed set of node kinds is understood; anything
 * else yields {@link ConstFail}, so the analyzer stays conservative.
 *
 * Also contains `extractConstantReturn`, the source of truth for constant
 * response hoisting. It is intentionally strict: a handler is only treated as
 * a single constant when it is an expression-bodied arrow or a block that
 * contains exactly one `return` statement. Conditional / multi-return
 * handlers are rejected rather than mis-hoisted.
 */

import { type Node, propertyName, type TemplateElement } from "./ast-types";
import { extractHandlerNodeAST } from "./handler";

export type ConstResult = { ok: true; value: unknown } | { ok: false };
export const constFail: ConstResult = { ok: false };

const isBigIntValue = (value: unknown): boolean => typeof value === "bigint";

/** Evaluate a node with the safe constant evaluator. */
export function evaluateConstantNode(node: Node): ConstResult {
  if (!node) return constFail;

  switch (node.type) {
    case "Literal":
    case "StringLiteral":
    case "NumericLiteral":
    case "BooleanLiteral":
    case "NullLiteral":
      // BigInt literals would crash JSON.stringify downstream — treat as
      // non-constant rather than propagate a throwing value.
      if (isBigIntValue(node.value)) return constFail;
      return { ok: true, value: node.value };

    case "Identifier":
      return node.name === "undefined" ? { ok: true, value: undefined } : constFail;

    case "TemplateLiteral":
      if (node.expressions?.length) return constFail;
      return {
        ok: true,
        value: node.quasis
          ?.map((q: TemplateElement) => q.value?.cooked ?? q.value?.raw ?? "")
          .join(""),
      };

    case "UnaryExpression": {
      const arg = evaluateConstantNode(node.argument);
      if (!arg.ok) return constFail;
      if (node.operator === "-") return { ok: true, value: -(arg.value as number) };
      if (node.operator === "+") return { ok: true, value: +(arg.value as number) };
      if (node.operator === "!") return { ok: true, value: !arg.value };
      return constFail;
    }

    case "ArrayExpression": {
      const vals: unknown[] = [];
      for (const el of node.elements ?? []) {
        if (!el || el.type === "SpreadElement") return constFail;
        const r = evaluateConstantNode(el);
        if (!r.ok) return constFail;
        vals.push(r.value);
      }
      return { ok: true, value: vals };
    }

    case "ObjectExpression": {
      const obj: Record<string, unknown> = {};
      for (const p of node.properties ?? []) {
        // Rejects spread, methods, getters/setters and computed keys.
        if (p.type !== "Property" || p.computed || p.kind !== "init") return constFail;
        const k = propertyName(p.key);
        if (typeof k !== "string" && typeof k !== "number") return constFail;
        const v = evaluateConstantNode(p.value);
        if (!v.ok) return constFail;
        obj[String(k)] = v.value;
      }
      return { ok: true, value: obj };
    }

    // Parens and TS type wrappers are transparent for constant evaluation.
    case "ParenthesizedExpression":
    case "TSAsExpression":
    case "TSTypeAssertion":
    case "TSNonNullExpression":
      return evaluateConstantNode(node.expression);

    default:
      return constFail;
  }
}

/**
 * Extract a single constant return value from a handler function node (or a
 * module AST, in which case the first exported handler is resolved).
 *
 * Returns `{ ok: true, value }` only when the handler is unambiguously a
 * constant:
 * - expression-bodied arrow → the expression is evaluated directly, or
 * - a block containing exactly one `return` statement, or
 * - an empty block → `undefined`.
 *
 * Anything with control flow, multiple statements, or multiple returns is
 * rejected. This prevents conditional handlers (`if (x) return a; return b;`)
 * from being mis-hoisted as a single constant response.
 */
export function extractConstantReturn(ast: Node): ConstResult {
  const fn =
    ast?.type === "Program"
      ? extractHandlerNodeAST(ast)
      : ast?.type === "ArrowFunctionExpression" || ast?.type === "FunctionExpression"
        ? ast
        : undefined;

  if (!fn) return { ok: true, value: undefined };

  const body = fn.body;
  if (!body) return { ok: true, value: undefined };

  // Expression-bodied arrow: `() => ({ ... })`.
  if (body.type !== "BlockStatement") {
    return evaluateConstantNode(body);
  }

  const statements = body.body ?? [];

  // Empty block → handler returns `undefined`; JSON.stringify(undefined) is
  // `undefined`, so callers never treat this as a hoistable constant.
  if (statements.length === 0) return { ok: true, value: undefined };

  // Only a block that is exactly one `return` is a single constant. Any
  // conditional / multi-return handler is rejected rather than mis-hoisted.
  const first = statements[0];
  if (statements.length !== 1 || first?.type !== "ReturnStatement") return constFail;

  if (!first.argument) return { ok: true, value: undefined };
  return evaluateConstantNode(first.argument);
}
