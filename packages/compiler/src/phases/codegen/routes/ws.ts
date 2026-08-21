/**
 * @fileoverview Codegen: WebSocket route emission.
 */

import type { RouteIR } from "../../../types";
import { methodHandlerName } from "../identifiers";
import type { CodegenState } from "../state";

/** Emit the upgrade handshake for a WS route (a normal GET upgrade). */
export const emitWsRoute = (state: CodegenState, route: RouteIR): void => {
  // WebSocket route: upgrade the request (a normal GET handshake), recording
  // the route path on the socket (`ws.data.__route`) so the server's single
  // `websocket` handler can dispatch open/message/close to the RIGHT route's
  // `wsHandler` when the app has more than one WS route.
  state.functions.push(`function ${methodHandlerName(route)}(req, params, server) {
  const upgraded = server.upgrade(req, { data: { __route: ${JSON.stringify(route.source.path)} } });
  if (!upgraded) return new Response("Upgrade failed", { status: 400 });
}`);
};
