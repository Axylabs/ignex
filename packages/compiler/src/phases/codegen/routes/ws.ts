/**
 * @fileoverview Codegen: WebSocket route emission.
 */

import type { RouteIR } from "../../../types";
import { methodHandlerName } from "../identifiers";
import type { CodegenState } from "../state";

/** Emit the upgrade handshake for a WS route (a normal GET upgrade). */
export const emitWsRoute = (state: CodegenState, route: RouteIR): void => {
  // WebSocket route: upgrade the request (a normal GET handshake); the
  // socket lifecycle is handled by the server's `websocket` option — the
  // route module's `wsHandler`.
  state.functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  const upgraded = server.upgrade(req);
  if (!upgraded) return new Response("Upgrade failed", { status: 400 });
}`);
};
