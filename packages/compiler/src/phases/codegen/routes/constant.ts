/**
 * @fileoverview Codegen: constant-response hoisting emission.
 */

import type { RouteIR } from "../../../types";
import { constantBodyVar, constantInitVar, methodHandlerName } from "../identifiers";
import type { CodegenState } from "../state";

/** Hoist a constant response to zero-cost frozen bodies. */
export const emitConstantRoute = (
  state: CodegenState,
  route: RouteIR,
  constantJson: string,
): void => {
  state.functions.push(`const ${constantBodyVar(route)} = ${constantJson};`);

  state.functions.push(`const ${constantInitVar(route)} = Object.freeze({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
});`);

  state.functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  return new Response(${constantBodyVar(route)}, ${constantInitVar(route)});
}`);
};
