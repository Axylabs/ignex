/**
 * Room (topic) membership + fan-out. Pure set operations over `state.rooms`,
 * wired to replay (`joinRoom` sends recorded history) and the outbound path
 * (`publishToRoom` fans a frame out to every member).
 */
import type { ServerWebSocket } from "bun";
import { doSend, sendFrame } from "./outbound";
import { recordReplay, replayFrames } from "./replay";
import type { ServerState, WsData } from "./state";

/** Join `ws` to `topic`, replaying any recorded history (oldest → newest). */
export function joinRoom(state: ServerState, ws: ServerWebSocket<WsData>, topic: string): void {
  ws.data.topics.add(topic);
  let set = state.rooms.get(topic);
  if (!set) {
    set = new Set();
    state.rooms.set(topic, set);
  }
  set.add(ws);
  // replay uses a direct send (not backpressure-gated) — matches the original
  for (const frame of replayFrames(state, topic)) doSend(state, ws, frame);
}

/** Leave `topic`; prune the room when it becomes empty. */
export function leaveRoom(state: ServerState, ws: ServerWebSocket<WsData>, topic: string): void {
  ws.data.topics.delete(topic);
  const set = state.rooms.get(topic);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) state.rooms.delete(topic);
}

/** Live topic names (with at least one subscriber). */
export function roomTopics(state: ServerState): string[] {
  return [...state.rooms.keys()];
}

/** Record replay (if enabled) then deliver `frame` to every room member. */
export function publishToRoom(state: ServerState, topic: string, frame: Uint8Array): void {
  recordReplay(state, topic, frame);
  const set = state.rooms.get(topic);
  if (!set) return;
  for (const ws of set) sendFrame(state, ws, frame);
}
