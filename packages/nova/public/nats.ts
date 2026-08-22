/**
 * Public NATS bridge API — standalone entrypoint (`ignex-nova/nats`).
 *
 *   import { createNatsBridge } from "ignex-nova/nats";
 *   const bridge = createNatsBridge({ servers: ["nats://localhost:4222"] });
 *   bridge.publish("ignex.broadcast.quote", frame);   // frame = wire bytes
 *
 * Most apps don't need this directly — pass `nats` to `createServer` and the
 * server bridges broadcast / topic / group publishes automatically.
 *
 * Generic: pass your own generated bindings so inbound frames decode YOUR
 * events: `createNatsBridge({ servers, bindings })`.
 */

export type {
  NatsBridge,
  NatsBridgeOptions,
  NatsBridgeStats,
  NatsBridgeStatus,
  NatsTransport,
} from "../src/bridge/nats";
export { createNatsBridge } from "../src/bridge/nats";
export { createSubjectBuilder, type SubjectBuilder } from "../src/bridge/subjects";
