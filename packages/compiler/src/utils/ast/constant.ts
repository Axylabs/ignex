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

import {
  type ArrayExpression,
  type Node,
  type ObjectExpression,
  propertyName,
  type TemplateElement,
  type UnaryExpression,
} from "./ast-types";
import { extractHandlerNodeAST } from "./handler";

export type ConstResult = { ok: true; value: unknown } | { ok: false };
export const constFail: ConstResult = { ok: false };

/**
 * A hoistable `new Response(body, init)` literal, pre-rendered for codegen.
 *
 * Produced only from statically-evaluable primitive arguments, so codegen can
 * re-run the SAME construction once at module load: the wire body and the
 * Response defaults are byte-identical to a per-request `new Response(...)`.
 */
export interface ConstantResponseSpec {
  /** JS source for the body argument (a primitive literal or `undefined`). */
  readonly bodyLit: string;
  /** JS source for the init object literal (`""` when the argument was omitted). */
  readonly initLit: string;
  /** Parsed status (200 when unspecified) — used for the native auto-HEAD fn. */
  readonly status: number;
}

/** The only `ResponseInit` keys we re-emit; anything else refuses the hoist. */
const RESPONSE_INIT_KEYS = new Set(["status", "statusText", "headers"]);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * Render a primitive body value as a JS literal whose `String()` coercion (the
 * `Response` body conversion) is exact. Objects/arrays are refused — their
 * coercion (`[object Object]`, array joining) is ambiguous and allocating.
 */
const bodyLiteral = (value: unknown): string | null => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return isFiniteNumber(value) ? String(value) : null;
  return null;
};

/**
 * Render an evaluated `ResponseInit` value as an object literal (or `null`
 * when it cannot be hoisted exactly). Unknown keys are REFUSED — re-emitting
 * only the known ones would silently drop whatever the runtime would have
 * honored. `headers` must be a plain string→string object so the emitted
 * literal carries the identical header values.
 */
const initLiteral = (value: unknown): { lit: string; status: number } | null => {
  if (value === undefined) return { lit: "", status: 200 };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;

  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!RESPONSE_INIT_KEYS.has(key)) return null;
  }

  const parts: string[] = [];
  let status = 200;

  if (obj.status !== undefined) {
    if (
      !isFiniteNumber(obj.status) ||
      !Number.isInteger(obj.status) ||
      obj.status < 200 ||
      obj.status > 599
    ) {
      return null;
    }
    status = obj.status;
    parts.push(`status: ${obj.status}`);
  }

  if (obj.statusText !== undefined) {
    if (typeof obj.statusText !== "string") return null;
    parts.push(`statusText: ${JSON.stringify(obj.statusText)}`);
  }

  if (obj.headers !== undefined) {
    const headers = obj.headers;
    if (typeof headers !== "object" || headers === null || Array.isArray(headers)) return null;
    for (const headerValue of Object.values(headers)) {
      if (typeof headerValue !== "string") return null;
    }
    parts.push(`headers: ${JSON.stringify(headers)}`);
  }

  return { lit: parts.length > 0 ? `{ ${parts.join(", ")} }` : "", status };
};

const isBigIntValue = (value: unknown): boolean => typeof value === "bigint";

/** Evaluate a unary expression against a constant argument. */
const evaluateUnary = (node: UnaryExpression): ConstResult => {
  const arg = evaluateConstantNode(node.argument);
  if (!arg.ok) return constFail;
  if (node.operator === "-") return { ok: true, value: -(arg.value as number) };
  if (node.operator === "+") return { ok: true, value: +(arg.value as number) };
  if (node.operator === "!") return { ok: true, value: !arg.value };
  return constFail;
};

/** Evaluate an array literal whose elements are all constant. */
const evaluateArray = (node: ArrayExpression): ConstResult => {
  const vals: unknown[] = [];
  for (const el of node.elements ?? []) {
    if (!el || el.type === "SpreadElement") return constFail;
    const r = evaluateConstantNode(el);
    if (!r.ok) return constFail;
    vals.push(r.value);
  }
  return { ok: true, value: vals };
};

/** Evaluate an object literal whose properties are all constant. */
const evaluateObject = (node: ObjectExpression): ConstResult => {
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
};

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

    case "UnaryExpression":
      return evaluateUnary(node);

    case "ArrayExpression":
      return evaluateArray(node);

    case "ObjectExpression":
      return evaluateObject(node);

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

/**
 * Resolve the single expression a handler returns — an expression-bodied arrow
 * body, or the sole `return` argument of a one-statement block. Shared by the
 * constant-return and response-literal extractors so both stay equally strict.
 */
const extractSingleReturnExpression = (ast: Node): Node | undefined => {
  const fn =
    ast?.type === "Program"
      ? extractHandlerNodeAST(ast)
      : ast?.type === "ArrowFunctionExpression" || ast?.type === "FunctionExpression"
        ? ast
        : undefined;

  if (!fn) return undefined;

  const body = fn.body;
  if (!body) return undefined;

  if (body.type !== "BlockStatement") return body;

  const statements = body.body ?? [];
  if (statements.length !== 1) return undefined;

  const first = statements[0];
  if (first?.type !== "ReturnStatement" || !first.argument) return undefined;
  return first.argument;
};

/** Parse a `new Response(...)` argument list into a hoistable spec (or `null`). */
const parseResponseSpec = (args: readonly Node[]): ConstantResponseSpec | null => {
  if (args.length > 2) return null;

  let bodyLit = "undefined";
  const bodyArg = args[0];
  if (bodyArg) {
    const evaluated = evaluateConstantNode(bodyArg);
    if (!evaluated.ok) return null;
    const lit = bodyLiteral(evaluated.value);
    if (lit === null) return null;
    bodyLit = lit;
  }

  let initLit = "";
  let status = 200;
  const initArg = args[1];
  if (initArg) {
    const evaluated = evaluateConstantNode(initArg);
    if (!evaluated.ok) return null;
    const parsed = initLiteral(evaluated.value);
    if (parsed === null) return null;
    initLit = parsed.lit;
    status = parsed.status;
  }

  return { bodyLit, initLit, status };
};

/**
 * Extract a hoistable `new Response(body, init)` literal from a handler with
 * the same strict single-constant-return shape as {@link extractConstantReturn}
 * (expression-bodied arrow, or a block with exactly one `return`).
 *
 * This is the `Response`-literal arm of constant-response hoisting: the JSON
 * arm covers handlers that RETURN a serializable value, while this covers
 * handlers that return a pre-built `Response` with statically-known arguments.
 * Only primitive bodies and a `status`/`statusText`/`headers` init are
 * accepted, so codegen can re-run the identical construction once at module
 * load (identical wire bytes and Response defaults). Anything with a computed
 * argument (identifier, call, spread) is refused.
 *
 * @returns The rendered spec, or `null` when not hoistable.
 */
export function extractConstantResponse(ast: Node): ConstantResponseSpec | null {
  const returned = extractSingleReturnExpression(ast);
  if (returned?.type !== "NewExpression") return null;

  const callee = returned.callee;
  if (callee?.type !== "Identifier" || callee.name !== "Response") return null;

  return parseResponseSpec(returned.arguments ?? []);
}
