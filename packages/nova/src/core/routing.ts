/**
 * Inbound routing — table-driven dispatch for app + control frames received
 * from a socket. Parses the envelope, enforces `maxMessageSize` + the inbound
 * allowlist, and routes to handlers / room operations.
 *
 * Decode is HEADER-FIRST: only the cheap envelope (version + event id) is
 * parsed before deciding what to do, so an event that isn't in the inbound
 * allowlist (or is a control frame) never pays the cost of a full `.unpack()`
 * payload decode — a client can't force us to fully materialize a frame we're
 * going to discard.
 */
import type { ServerWebSocket } from "bun";
import type { ControlEventName, ControlEvents } from "../schema";
import { joinGroup, leaveGroup } from "./groups";
import { sendControl } from "./outbound";
import { joinRoom, leaveRoom } from "./rooms";
import type { ServerState, WsData } from "./state";

// allocated once per process, reused for every inbound text frame
const textEncoder = new TextEncoder();

export function handleMessage(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  raw: string | Buffer,
): void {
  const bytes = typeof raw === "string" ? textEncoder.encode(raw) : new Uint8Array(raw as Buffer);
  if (state.maxMessageSize !== undefined && bytes.byteLength > state.maxMessageSize) {
    state.metrics.protocolErrors++;
    ws.close(1009, "message too big");
    return;
  }
  const header = state.bindings.readFrameHeader(bytes);
  if (!header) {
    state.metrics.protocolErrors++;
    return; // undecodable / wrong version / unknown id — drop
  }
  if (state.bindings.isControlId(header.id)) {
    state.metrics.inboundControl++;
    handleControl(
      state,
      ws,
      header.name as ControlEventName,
      state.bindings.decodePayload(header.id, bytes) as never,
    );
    return;
  }
  const name = header.name;
  if (!state.inbound.has(name)) return; // not an allowed inbound event — no payload decode
  state.metrics.inbound++;
  state.inboundHandlers.get(name)?.(state.bindings.decodePayload(header.id, bytes), ws);
  // Horizontal scaling: when the bridge is configured with `bridgeClientEvents`,
  // every accepted client event is re-published to `{prefix}.inbound.<event>` so
  // OTHER server instances (and BE consumers) receive it. NATS-inbound frames
  // arrive via `onInbound` → `fanOutAll` (never through this path), so there is
  // no loop; this server's own clients are re-delivered exactly once through its
  // own inbound subscription (the app handler should therefore not ALSO
  // broadcast, or the event would be delivered twice locally).
  if (state.bridge?.clientEvents) {
    state.bridge.publish(state.bridge.subjects.inboundEvent(name), bytes);
  }
}

export function handleControl(
  state: ServerState,
  ws: ServerWebSocket<WsData>,
  name: ControlEventName,
  payload: unknown,
): void {
  switch (name) {
    case "hello": {
      const p = payload as ControlEvents["hello"];
      ws.data.version = p.version;
      ws.data.lastSeq = p.lastSeq;
      if (p.version !== state.bindings.wireVersion) {
        // protocol version mismatch — refuse this client
        ws.close(1002, "wire version mismatch");
      }
      break;
    }
    case "subscribe": {
      joinRoom(state, ws, (payload as ControlEvents["subscribe"]).topic);
      break;
    }
    case "unsubscribe": {
      leaveRoom(state, ws, (payload as ControlEvents["unsubscribe"]).topic);
      break;
    }
    case "joinGroup": {
      joinGroup(state, ws, (payload as ControlEvents["joinGroup"]).group);
      break;
    }
    case "leaveGroup": {
      leaveGroup(state, ws, (payload as ControlEvents["leaveGroup"]).group);
      break;
    }
    case "ping": {
      sendControl(state, ws, "pong", { ts: (payload as ControlEvents["ping"]).ts });
      break;
    }
    case "pong":
      // client keepalive reply — tracked on the client side (heartbeat)
      break;
    case "snapshotRequest":
      // per-topic replay from the ring buffer (see replay.ts)
      break;
  }
}
