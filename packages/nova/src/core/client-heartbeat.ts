/**
 * Client app-level Ping/Pong heartbeat — detects half-open connections and
 * forces a close so the reconnect path re-establishes the socket.
 */

import type { ClientState } from "./client-state";
import { sendControl } from "./client-wire";

export function startHeartbeat(state: ClientState): void {
  const ms = state.opts.heartbeatMs ?? 15000;
  if (ms <= 0) return;
  state.lastPong = Date.now();
  sendControl(state, "ping", { ts: Date.now() });
  const misses = Math.max(1, state.opts.heartbeatMisses ?? 2);
  state.heartbeatTimer = setInterval(() => {
    if (Date.now() - state.lastPong > ms * misses) {
      // connection is dead — force close so onclose triggers reconnect
      state.ws?.close();
      return;
    }
    sendControl(state, "ping", { ts: Date.now() });
  }, ms);
}

export function stopHeartbeat(state: ClientState): void {
  if (state.heartbeatTimer) clearInterval(state.heartbeatTimer);
  state.heartbeatTimer = null;
}
