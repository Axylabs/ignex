/**
 * Independent NATS consumer for ignex-nova bridged events.
 *
 *   bun run examples/nats-consumer.ts                       # NATS on localhost
 *   NATS_URL=nats://host:4222 SUBJECT='ignex.topic.>' bun run examples/nats-consumer.ts
 *
 * The server bridges every broadcast / topic / group publish to NATS as the
 * SAME FlatBuffer wire frame it sends to WebSocket clients:
 *
 *   frame = [WIRE_VERSION:1][event_id:u32 LE][size-prefixed FlatBuffer]
 *
 * This consumer parses the envelope, maps the FNV-1a event id → name using the
 * generated `wire-registry.json` (a machine-readable id map that works in ANY
 * language), and decodes the payload to a plain typed object via the generated
 * registry. A consumer in another language can decode the same bytes using
 * `src/generated/fbs/backend.fbs` + `wire-registry.json`.
 *
 * Requires: `bun run generate` (for the registry + wire-registry.json) and a
 * running NATS server (`docker run --rm -p 4222:4222 nats`).
 */
import { connect } from "nats";
import { decodeFrame, readFrameHeader } from "../src/generated/registry";

const NATS_URL = process.env.NATS_URL ?? "nats://localhost:4222";
const SUBJECT = process.env.SUBJECT ?? "ignex.>";

// machine-readable id → name map (generated; also useful to non-TS consumers)
const regPath = new URL("../src/generated/wire-registry.json", import.meta.url);
const wireRegistry = JSON.parse(await Bun.file(regPath).text()) as {
  version: number;
  events: Record<string, number>;
};
const idToName = new Map<number, string>(
  Object.entries(wireRegistry.events).map(([name, id]) => [id, name]),
);

const nc = await connect({ servers: [NATS_URL] });
console.log(
  `listening on ${SUBJECT} @ ${NATS_URL}  (${idToName.size} known events, wire v${wireRegistry.version})`,
);

const sub = nc.subscribe(SUBJECT);
for await (const m of sub) {
  const frame = new Uint8Array(m.data);
  const header = readFrameHeader(frame);
  const name = header?.name ?? idToName.get(header?.id ?? -1) ?? "unknown";
  const decoded = header ? decodeFrame(frame) : null;
  console.log(
    `[${m.subject}] ${name} (id=${header?.id ?? "?"}, ${frame.length} bytes)`,
    decoded?.payload ?? decoded,
  );
}
