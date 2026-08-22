/**
 * Bring-your-own-schema example — the full generic flow in one place:
 *
 *   1. generateBindings(yourSchema)  →  ignex/generated/ (fbs + decoders +
 *      registry + pure-JS encoder + wire-registry.json + rust crate scaffold)
 *   2. makeBindings(yourSchema)      →  a runtime `Bindings`
 *   3. createServer / createClient / createNatsBridge  with `{ bindings }`
 *
 * The point: the transport, the NATS bridge and the typed APIs are NOT tied to
 * the built-in quote/trade/portfolio events — any TypeBox schema works.
 *
 * Run the steps in YOUR app (this file is a template, not a test):
 *
 *   bun scripts/generate-bindings.ts   # step 1 — needs flatc on PATH
 *   bun run your-server.ts             # steps 2–3
 *
 * See docs/generic-bindings.md for the full guide (incl. the optional Rust FFI
 * fast path via `cargo build --release` in ignex/generated/rust).
 */
import { type TSchema, Type } from "@sinclair/typebox";
import { createClient } from "../public/client";
import { generateBindings } from "../public/generate";
import { createServer } from "../public/server";

// ── 1. YOUR schema (this would live in src/schema.ts in a real app) ──────
const ChatMsg = Type.Object(
  { room: Type.String(), text: Type.String(), ts: Type.Integer() },
  { additionalProperties: false },
);
const Telemetry = Type.Object(
  { device: Type.String(), readings: Type.Array(Type.Number()), ok: Type.Boolean() },
  { additionalProperties: false },
);

const schema = {
  schemas: { ChatMsg, Telemetry },
  events: { chat: ChatMsg, telemetry: Telemetry },
  controlEvents: {},
};

// ── 2. generate + assemble the bindings ──────────────────────────────────
const gen = generateBindings(schema, { outDir: "./ignex/generated" });
gen.write();
console.log(`generated ${Object.keys(gen.files).length} files, fingerprint ${gen.fingerprint}`);

// In your app the generated module is a normal file: `import { makeBindings } from "./ignex/generated"`.
// (A dynamic, runtime-only import keeps this example typecheckable before the
// first `generateBindings` run has created the folder.)
import type { Bindings } from "../src/bindings/types";

type MakeBindings = <E extends Record<string, TSchema>, C extends Record<string, TSchema>>(s: {
  events: E;
  controlEvents?: C;
}) => Omit<Bindings, "events" | "controlEvents"> & { events: E; controlEvents: C };
const { makeBindings } = (await import("./ignex/generated/index.ts" as string)) as {
  makeBindings: MakeBindings;
};
const bindings = makeBindings(schema);

// ── 3. use the generic APIs — all typed against YOUR events ──────────────
const server = createServer({
  port: 3000,
  bindings,
  inbound: ["chat"],
  nats: { servers: ["nats://localhost:4222"], inbound: true, bridgeClientEvents: true },
});
server.publish("chat", { room: "lobby", text: "hello from the server", ts: Date.now() });
server.on("chat", (msg) => console.log("server got:", msg.room, msg.text));

const client = createClient("ws://localhost:3000/ws", { bindings });
client.on("telemetry", (t) => console.log("FE got:", t.device, t.readings));
client.send("chat", { room: "lobby", text: "hello from the FE", ts: Date.now() });
client.connect();
