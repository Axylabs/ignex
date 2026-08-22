/**
 * Outbound write path — the ONLY place that talks to `ws.send` and mutates the
 * per-socket backpressure queue / send counters. `sendFrame` executes the pure
 * `decide()` result; `doSend` is the single accounting point.
 */
import type { ServerWebSocket } from "bun";
import type { ControlEventName, ControlEvents } from "../schema";
import { decide } from "./backpressure";
import { RingBuffer } from "./ring";
import type { ServerState, WsData } from "./state";

/** Actual socket write + counters (single accounting point). */
export function doSend(state: ServerState, ws: ServerWebSocket<WsData>, frame: Uint8Array): void {
  ws.send(frame);
  state.metrics.sent++;
  state.metrics.bytesSent += frame.byteLength;
}

/**
 * Send one frame to a socket, honoring the configured backpressure policy.
 * Happy path (no backpressure configured, or socket under the high-water mark)
 * is a direct `ws.send` — zero allocations. Under pressure, `ws.send` is
 * replaced by a bounded queue (drop-oldest) / skip (drop-newest) / close
 * (disconnect).
 */
export function sendFrame(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  frame: Uint8Array,
): void {
  const bp = state.bp;
  if (!bp) {
    doSend(state, ws, frame);
    return;
  }
  const d = decide(bp, ws);
  switch (d.kind) {
    case "send":
      doSend(state, ws, frame);
      return;
    case "close":
      state.metrics.disconnectedSlow++;
      ws.close(1013, "slow consumer");
      return;
    case "drop-newest":
      state.metrics.droppedNewest++;
      return;
    case "enqueue": {
      // RingBuffer: O(1) push + drop-from-head (no array shift() memmove).
      let q = ws.data.queue;
      if (q === undefined) {
        q = new RingBuffer<Uint8Array>();
        ws.data.queue = q;
      }
      q.push(frame.slice()); // owned copy for the queue
      for (let i = 0; i < d.dropHead; i++) {
        q.shift();
        state.metrics.droppedOldest++;
      }
      return;
    }
  }
}

/** Flush a slow socket's drop-oldest queue as the OS buffers drain. */
export function drainSocket(state: ServerState, ws: ServerWebSocket<WsData>): void {
  const q = ws.data.queue;
  if (!q || q.length === 0 || !state.bp) return;
  while (q.length > 0) {
    if (ws.getBufferedAmount() > state.bp.highWaterMark) break; // still backed up
    doSend(state, ws, q.shift()!);
  }
}

/** Send a control frame (hello / subscribe / ping / ...) through the same outbound path. */
export function sendControl<K extends ControlEventName>(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  name: K,
  payload: ControlEvents[K],
): void {
  sendFrame(state, ws, state.transport.encodeToScratch(name, payload));
}
