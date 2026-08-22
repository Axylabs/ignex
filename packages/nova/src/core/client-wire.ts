/**
 * Client wire handling — outbound frame sends + inbound decode/dispatch.
 * `handleMessage` decodes the envelope, filters control frames, and fans app
 * events out to the registered handlers. All decode/encode goes through
 * `state.bindings`, so a client speaks whatever wire stack it was given.
 */
import type { ControlEventName, ControlEvents } from "../schema";
import type { ClientState } from "./client-state";

/** Send an encoded frame, if the socket is open. */
export function sendFrame(state: ClientState, frame: Uint8Array): void {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error("ignex: client is not connected");
  // Bun's send() wants an ArrayBuffer-backed view; cast the (owned) frame.
  ws.send(frame as Uint8Array<ArrayBuffer>);
}

export function sendControl<K extends ControlEventName>(
  state: ClientState,
  name: K,
  payload: ControlEvents[K],
): void {
  sendFrame(state, state.bindings.encodeFrame(name, payload));
}

export function emitError(state: ClientState, err: Error): void {
  for (const cb of state.errorCbs) cb(err);
}

export function handleControl(state: ClientState, name: ControlEventName, payload: unknown): void {
  switch (name) {
    case "hello": {
      const p = payload as ControlEvents["hello"];
      if (p.version !== state.bindings.wireVersion) {
        // server speaks a different wire version — refuse + surface
        state.ws?.close(1002, "wire version mismatch");
        emitError(
          state,
          new Error(
            `ignex: server wire version ${p.version} does not match ${state.bindings.wireVersion}`,
          ),
        );
      }
      break;
    }
    case "welcome": {
      const p = payload as ControlEvents["welcome"];
      state.clientId = p.clientId;
      state.groups = [...p.groups];
      break;
    }
    case "pong":
      state.lastPong = Date.now();
      break;
    default:
      break;
  }
}

export function handleMessage(state: ClientState, data: ArrayBuffer | string): void {
  if (typeof data === "string") return; // ignore text frames
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data as Uint8Array);
  const frame = state.bindings.decodeFrame(bytes);
  if (!frame) {
    emitError(state, new Error("ignex: undecodable / version-mismatched frame dropped"));
    return;
  }
  if (state.bindings.isControlId(frame.id)) {
    handleControl(state, frame.name as ControlEventName, frame.payload);
    return;
  }
  const name = frame.name;
  const set = state.handlers.get(name);
  if (set) for (const cb of set) cb(frame.payload);
  for (const cb of state.anyHandlers) cb(name, frame.payload);
}
