/**
 * Per-topic replay history (last-value snapshots on subscribe / reconnect).
 * Pure data operations on `state.topicHistory` — no socket writes here
 * (`rooms.joinRoom` reads the recorded frames via `replayFrames`).
 *
 * History is a bounded `RingBuffer` (capacity = historySize): recording is O(1)
 * and, once full, the OLDEST frame is overwritten automatically — same
 * semantics as the old `push` + `shift`, but without the O(n) array shift.
 */
import { RingBuffer } from "./ring";
import type { ServerState } from "./state";

/** Record an owned copy of `frame` for `topic`, bounded to historySize. */
export function recordReplay(state: ServerState, topic: string, frame: Uint8Array): void {
  if (!state.replay) return;
  let hist = state.topicHistory.get(topic);
  if (!hist) {
    hist = new RingBuffer<{ seq: number; frame: Uint8Array }>(state.replay.historySize, true);
    state.topicHistory.set(topic, hist);
  }
  hist.push({ seq: ++state.replaySeq, frame: frame.slice() }); // owned copy for replay
}

/** The recorded frames for `topic`, oldest → newest (already owned copies). */
export function replayFrames(state: ServerState, topic: string): Uint8Array[] {
  const hist = state.topicHistory.get(topic);
  if (!hist || hist.length === 0) return [];
  const out: Uint8Array[] = [];
  for (const e of hist) out.push(e.frame);
  return out;
}
