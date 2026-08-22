/**
 * Public client API — thin re-export shim (keeps the npm entrypoint + `dist`
 * build stable). The implementation lives in the functional modules under
 * `src/core/`; this file just exposes the public surface.
 *
 *   import { createClient } from "ignex-nova/client";
 *
 *   const client = createClient("ws://localhost:3000/ws", { reconnect: true });
 *   client.on("quote", (q) => { /* q: Events["quote"] — a plain object *\/ });
 *   client.subscribe("equities");   // server-side room membership (+ last-value replay)
 *   client.send("chat", {...});     // typed client→server (server must allow it)
 *   client.connect();
 *
 *   // your own schema (see ignex-nova/generate):
 *   const client = createClient("ws://localhost:3000/ws", { bindings });
 *   client.on("yourEvent", (e) => {...}); // typed against YOUR Events
 *
 * Works in the browser (bundle with `bun build --target=browser`) AND in Bun.
 * Outgoing frames are encoded by the generated PURE-JS encoder — no Rust FFI
 * needed, so the browser can send too.
 */
export { createClient, type IgnClient } from "../src/core/client";
export type {
  ClientStatus,
  IgnClientOptions,
  IgnReconnectOptions,
} from "../src/core/client-state";
