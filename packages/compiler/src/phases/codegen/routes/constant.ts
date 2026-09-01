/**
 * @fileoverview Codegen: constant-response hoisting emission.
 */

import type { RouteIR } from "../../../types";
import { heatCountStmt } from "../heat";
import {
  constantBodyVar,
  constantInitVar,
  headConstName,
  methodHandlerName,
  staticResponseName,
} from "../identifiers";
import type { CodegenState } from "../state";

/**
 * Hoist a constant response to a PRE-BUILT, frozen `Response` bound directly
 * into Bun's native routes table: Bun serves it entirely in Rust — zero
 * per-request JS (no wrapper call, no `new Response`, no header merge) — with
 * native auto-HEAD (body stripped, status/headers preserved) and free
 * conditional-GET handling when a route ever carries an ETag.
 *
 * Safety: this path only fires when the app has NO lifecycle hooks/plugins
 * (`tryNormalizeConstant(route, hasGlobalLifecycle)` refuses otherwise), so no
 * hook-driven response mutations can be skipped. Unmatched methods still fall
 * through to the JS fallback (`__fallback` → 405), exactly like wrapped
 * routes.
 *
 * Statically sync + provably wildcard-free; recorded in
 * `state.staticResponses` so the route-table pass binds the value instead of
 * the handler function.
 */
export const emitConstantRoute = (
  state: CodegenState,
  route: RouteIR,
  constantJson: string,
): void => {
  const ref = route.codegen.handlerRef;
  const bodyVar = constantBodyVar(route);
  const initVar = constantInitVar(route);

  state.functions.push(`const ${bodyVar} = ${constantJson};`);

  state.functions.push(`const ${initVar} = Object.freeze({
  status: 200,
  headers: { "content-type": "application/json; charset=utf-8" },
});`);

  // Dev heat capture needs a per-request JS statement to count into; native
  // static serving never runs JS, so those builds keep the legacy handler +
  // wrapper emission (identical to the pre-promotion behavior).
  const heatLine = heatCountStmt(route, state.cfg.heatCapture);
  if (heatLine) {
    const handler = methodHandlerName(route);
    state.functions.push(`function ${handler}(req, params, server) {
  ${heatLine}
  return new Response(${bodyVar}, ${initVar});
}`);
    state.wrapVariants.set(handler, "static-sync");
    if (route.source.method === "GET") {
      state.constantGets.add(ref);
      state.functions.push(`function ${headConstName(ref)}(req, params, server) {
  return new Response(null, ${initVar});
}`);
    }
    return;
  }

  // One shared Response instance per route, built once at module load. Bun
  // snapshots buffered bodies for table-bound values and never hands user JS
  // a chance to consume them, so sharing is safe (verified against Bun 1.4:
  // repeated/concurrent GETs + auto-HEAD all serve correctly).
  //
  // The body MUST be the JSON TEXT (`constantJson`, exactly what `jsonReply`'s
  // JSON.stringify would put on the wire) — NOT the re-parsed JS value, which
  // for strings/objects would serialize differently ("Hello World" vs
  // "\"Hello World\"", or `[object Object]`). `JSON.stringify(constantJson)`
  // embeds it as a safely-escaped JS string literal.
  const resVar = staticResponseName(ref);
  state.functions.push(
    `const ${resVar} = new Response(${JSON.stringify(constantJson)}, ${initVar});`,
  );

  state.staticResponses.set(methodHandlerName(route), resVar);

  // The GET entry needs no emitted HEAD fn either — Bun strips the body of
  // HEAD requests to table-bound Response values natively (with the GET
  // content-length preserved, matching RFC 9110 §9.3.2).
  if (route.source.method === "GET") {
    state.constantGets.add(ref);
  }
};
