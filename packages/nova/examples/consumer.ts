/**
 * Typed-consumer smoke: imports ONLY the public API (no FlatBuffer, no FFI).
 * Type-checking this file (tsc / bun test) proves the standard API surface.
 */
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import type { Events } from "../src/schema";

const server = createServer({ port: 3000 });

const quote: Events["quote"] = {
  symbol: "AAPL",
  bid: 180.1,
  ask: 180.2,
  bidSize: 100,
  askSize: 200,
  ts: Date.now(),
};
server.publish("quote", quote);

const client = createClient("ws://localhost:3000/ws");
client.on("quote", (q) => {
  const symbol: string = q.symbol;
  void symbol;
});
client.on("trade", (t) => {
  const side: "buy" | "sell" = t.side;
  void side;
});
client.on("portfolio", (p) => {
  const total: number = p.totalValue;
  const first: Events["portfolio"]["positions"][number] = p.positions[0]!;
  void total;
  void first;
});
client.connect();

// @ts-expect-error — unknown events are rejected at compile time
client.on("nope", () => {});

// @ts-expect-error — wrong payload shape is rejected
server.publish("quote", { symbol: 42 });

export { client, server };
