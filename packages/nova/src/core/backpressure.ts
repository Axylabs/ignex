/**
 * Backpressure decision — a PURE function: given the policy + the socket's
 * current state, return what `outbound.sendFrame` should do. No side effects
 * here (no queue mutation, no counters) — that makes each policy testable in
 * isolation and keeps the actual effects in exactly one place (`outbound.ts`).
 */
import type { ServerWebSocket } from "bun";
import type { IgnBackpressureOptions, WsData } from "./state";

export type SendDecision =
  | { kind: "send" }
  | { kind: "close" }
  | { kind: "drop-newest" }
  /** push the frame to the socket's drop-oldest queue, then trim `dropHead` oldest */
  | { kind: "enqueue"; dropHead: number };

export function decide(
  bp: Required<IgnBackpressureOptions>,
  ws: ServerWebSocket<WsData>,
): SendDecision {
  const hwm = bp.highWaterMark;
  switch (bp.policy) {
    case "disconnect":
      return ws.getBufferedAmount() > hwm ? { kind: "close" } : { kind: "send" };
    case "drop-newest":
      return ws.getBufferedAmount() > hwm ? { kind: "drop-newest" } : { kind: "send" };
    case "drop-oldest":
    default: {
      const q = ws.data.queue;
      if (q && q.length > 0) {
        // already backed up — enqueue an owned copy; while over maxQueue, drop from the head
        const dropHead = Math.max(0, q.length + 1 - bp.maxQueue);
        return { kind: "enqueue", dropHead };
      }
      if (ws.getBufferedAmount() > hwm) return { kind: "enqueue", dropHead: 0 };
      return { kind: "send" };
    }
  }
}
