/**
 * Client auto-reconnect — pure backoff math (`nextDelay`) + a scheduler that
 * drives the state machine. `connect` is passed in by the composition root so
 * the timer can re-establish the socket.
 */

import type { Bindings } from "../bindings/types";
import {
  type ClientState,
  type IgnClientOptions,
  type IgnReconnectOptions,
  setStatus,
} from "./client-state";

/** Resolve the effective reconnect options (defaults applied). */
export function reconnectOpts(opts: IgnClientOptions<Bindings>): IgnReconnectOptions | null {
  const rc = opts.reconnect;
  if (rc === undefined || rc === false) return null;
  if (rc === true) return { initialDelay: 250, maxDelay: 30000, jitter: true };
  return { initialDelay: 250, maxDelay: 30000, jitter: true, ...rc };
}

/** Pure exponential-backoff delay (ms) for a given attempt count. */
export function nextDelay(attempts: number, opts: IgnReconnectOptions): number {
  const initial = opts.initialDelay ?? 250;
  const max = opts.maxDelay ?? 30000;
  const base = Math.min(initial * 2 ** attempts, max);
  return opts.jitter === false ? base : base * (0.5 + Math.random());
}

export function scheduleReconnect(state: ClientState, connect: () => void): void {
  const rc = reconnectOpts(state.opts);
  if (!rc) {
    setStatus(state, "closed");
    return;
  }
  setStatus(state, "disconnected");
  const delay = nextDelay(state.attempts, rc);
  state.attempts++;
  setStatus(state, "reconnecting");
  state.reconnectTimer = setTimeout(() => connect(), delay);
}
