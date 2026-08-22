/**
 * Backpressure + graceful-drain tests (Phase 3).
 *
 * Strategy for deterministic slow-consumer simulation: set a tiny
 * `highWaterMark` (1 byte) and publish a LARGE SYNCHRONOUS burst — the client
 * cannot read any frames until the loop yields, so the server's per-socket
 * buffered amount stays over the high-water mark throughout the burst and the
 * policy counter increments deterministically.
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import type { Events } from "../src/schema";
import { openWs, quote, waitFor } from "./helpers";

const big = "x".repeat(2048);
const payload = (i: number): Events["quote"] =>
  quote(big, { bid: i, ask: i + 0.5, bidSize: 1, askSize: 2, ts: i });

describe("backpressure policies", () => {
  test("drop-newest skips sends to a saturated socket", async () => {
    const server = createServer({
      port: 0,
      backpressure: { highWaterMark: 1, policy: "drop-newest" },
    });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    await Bun.sleep(50); // let the hello frame flush so the burst fills the buffer
    let received = 0;
    ws.onmessage = () => received++;

    const N = 2000;
    for (let i = 0; i < N; i++) server.publish("quote", payload(i)); // synchronous burst
    await Bun.sleep(200);

    const m = server.getMetrics();
    expect(m.published).toBe(N);
    expect(m.droppedNewest).toBeGreaterThan(0);
    expect(received).toBeLessThan(N); // most frames skipped

    ws.close();
    server.stop();
  });

  test("drop-oldest bounds the per-socket queue and drops from the head", async () => {
    const server = createServer({
      port: 0,
      backpressure: { highWaterMark: 1, policy: "drop-oldest", maxQueue: 16 },
    });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    await Bun.sleep(50);
    ws.onmessage = () => {};

    const N = 2000;
    for (let i = 0; i < N; i++) server.publish("quote", payload(i)); // synchronous burst
    await Bun.sleep(200);

    const m = server.getMetrics();
    expect(m.droppedOldest).toBeGreaterThan(0); // the queue stayed bounded
    expect(m.sent).toBeLessThanOrEqual(N); // sent only counts actual writes

    ws.close();
    server.stop();
  });

  test("disconnect policy closes a slow consumer", async () => {
    const server = createServer({
      port: 0,
      backpressure: { highWaterMark: 1, policy: "disconnect" },
    });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    await Bun.sleep(50);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };

    const N = 2000;
    for (let i = 0; i < N; i++) server.publish("quote", payload(i)); // synchronous burst
    await waitFor(() => closed);
    await waitFor(() => server.clientCount === 0); // server cleanup after close

    const m = server.getMetrics();
    expect(m.disconnectedSlow).toBeGreaterThan(0);
    expect(m.connectedClients).toBe(0);

    server.stop();
  });

  test("no backpressure configured → no drops (happy path untouched)", async () => {
    const server = createServer({ port: 0 });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    let received = 0;
    ws.onmessage = () => received++;

    const N = 100;
    for (let i = 0; i < N; i++) server.publish("quote", payload(i));
    await waitFor(() => received >= N);

    const m = server.getMetrics();
    expect(m.droppedNewest).toBe(0);
    expect(m.droppedOldest).toBe(0);
    expect(m.disconnectedSlow).toBe(0);

    ws.close();
    server.stop();
  });
});

describe("graceful drain", () => {
  test("drain() stops accepting and closes sockets (client observes close)", async () => {
    const server = createServer({ port: 0 });
    const ws = await openWs(`ws://localhost:${server.port}/ws`);
    expect(server.clientCount).toBe(1);

    server.publish("quote", payload(1));
    await server.drain(1000);

    await waitFor(() => server.clientCount === 0);
    await waitFor(() => ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING);
    server.stop();
  });
});
