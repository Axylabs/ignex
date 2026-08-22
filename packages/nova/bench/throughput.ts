/**
 * End-to-end throughput: publish N typed events from a Bun server and count
 * them on a client WebSocket. Requires generate + build:rust.
 *
 *   bun run bench:throughput   (TOTAL=100000 for more)
 */
import { createServer } from "../public/server";

const TOTAL = Number(process.env.TOTAL ?? 20_000);
const server = createServer({ port: 0 });
const url = `ws://localhost:${server.port}/ws`;

const quote = {
  symbol: "AAPL",
  bid: 180.25,
  ask: 180.3,
  bidSize: 100,
  askSize: 200,
  ts: 1720000000000,
};

let received = 0;
let serverNs = 0n;

const done = new Promise<void>((resolve) => {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    const t0 = process.hrtime.bigint();
    for (let i = 0; i < TOTAL; i++) server.publish("quote", quote);
    serverNs = process.hrtime.bigint() - t0;
  };
  ws.onmessage = () => {
    received++;
    if (received === TOTAL) {
      ws.close();
      resolve();
    }
  };
});

await done;

const serverMs = Number(serverNs) / 1e6;
console.log(
  `server publish ×${TOTAL}: ${serverMs.toFixed(1)} ms → ${((TOTAL / serverMs) * 1000).toFixed(0).padStart(7)} msg/s (server-side)`,
);
console.log(`client received: ${received}/${TOTAL}`);

server.stop();
