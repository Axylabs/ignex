/**
 * @fileoverview AST-based purity analysis.
 *
 * Decides whether a module body is "pure" — free of I/O, side effects,
 * clocks, randomness and `await` — which is the precondition for constant
 * response hoisting at build time. The analysis is deliberately conservative:
 * any construct we cannot prove pure is treated as impure.
 */

import { type Node, propertyName } from "./ast-types";
import { walk } from "./walk";

/** Globals whose mere use (call or `new`) is impure. */
const IMPURE_GLOBALS = new Set([
  "fetch",
  "Date",
  "Math",
  "console",
  "process",
  "crypto",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "Promise",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
]);

/** Member call chains that are impure (e.g. `Math.random()`). */
const IMPURE_CALLS = new Set([
  "Math.random",
  "Date.now",
  "crypto.randomUUID",
  "crypto.getRandomValues",
  "console.log",
  "console.warn",
  "console.error",
  "fetch",
]);

/**
 * Flatten a non-computed member expression into a dotted string
 * (`ctx.body` → `"ctx.body"`), or `null` when the shape is unsupported.
 * Also used by response-type inference.
 */
export function flattenMember(node: Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "MemberExpression" && !node.computed) {
    const obj = flattenMember(node.object);
    const prop = propertyName(node.property);
    if (obj && typeof prop === "string") return `${obj}.${prop}`;
  }
  return null;
}

/** True when the (module) body contains no provably impure construct. */
export function isPureBodyAST(ast: Node): boolean {
  let impure = false;

  walk(ast, (n) => {
    if (impure) return;
    // new Date(), new Map(), etc.
    if (
      n.type === "NewExpression" &&
      n.callee?.type === "Identifier" &&
      IMPURE_GLOBALS.has(n.callee.name)
    ) {
      impure = true;
      return;
    }
    // fetch(), Math.random(), console.*, etc.
    if (n.type === "CallExpression") {
      const callee = n.callee;
      if (callee.type === "Identifier" && IMPURE_GLOBALS.has(callee.name)) {
        impure = true;
        return;
      }
      if (callee.type === "MemberExpression") {
        const chain = flattenMember(callee);
        if (chain && IMPURE_CALLS.has(chain)) impure = true;
      }
    }
    // await — conservative: could be a DB call, fetch, etc.
    if (n.type === "AwaitExpression") impure = true;
  });

  return !impure;
}
