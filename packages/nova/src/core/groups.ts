/**
 * Group membership + fan-out — a server-side targeting dimension (complements
 * rooms: rooms are client-joinable with optional replay; groups are for
 * server-side targeting, NO replay). Pure set operations over `state.groups`.
 *
 * A socket's groups live in `ws.data.groups`; `state.groups` is the reverse
 * group → member-sockets index. Groups can be seeded from `authenticate`
 * metadata, joined programmatically via `joinGroup`, or joined by the client
 * via the `joinGroup` / `leaveGroup` control frames (routed in `routing.ts`).
 */
import type { ServerWebSocket } from "bun";
import { sendFrame } from "./outbound";
import type { ServerState, WsData } from "./state";

/** Add `ws` to `group` (idempotent) and index it in `state.groups`. */
export function joinGroup(state: ServerState, ws: ServerWebSocket<WsData>, group: string): void {
  ws.data.groups.add(group);
  let set = state.groups.get(group);
  if (!set) {
    set = new Set();
    state.groups.set(group, set);
  }
  set.add(ws);
  // events-layer hook (auth seed, control frames, programmatic joins all pass here)
  state.onGroupChange?.(group, ws, true);
}

/** Remove `ws` from `group`; prune the group when it becomes empty. */
export function leaveGroup(state: ServerState, ws: ServerWebSocket<WsData>, group: string): void {
  ws.data.groups.delete(group);
  const set = state.groups.get(group);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) state.groups.delete(group);
  state.onGroupChange?.(group, ws, false);
}

/** Fan `frame` out to every member of `group` (no replay). */
export function publishToGroup(state: ServerState, group: string, frame: Uint8Array): void {
  const set = state.groups.get(group);
  if (!set) return;
  for (const ws of set) sendFrame(state, ws, frame);
}

/** Live group names (with at least one member). */
export function activeGroups(state: ServerState): string[] {
  return [...state.groups.keys()];
}

/** Client ids that are currently members of `group`. */
export function groupMembers(state: ServerState, group: string): string[] {
  const set = state.groups.get(group);
  if (!set) return [];
  return [...set].map((ws) => ws.data.id);
}
