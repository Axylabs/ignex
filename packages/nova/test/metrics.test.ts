/**
 * Metrics + /health tests (Phase 3):
 *   - counters track publish / sent / inbound / control / protocol errors
 *   - per-event encode path counts (direct vs JSON) are observable
 *   - /health returns a JSON snapshot, not a bare "ok"
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { order, quote, trade, waitFor } from "./helpers";

const emptyOrder = order({ lines: [], notes: [], discounts: [], createdAt: 1 });

describe("server metrics", () => {
  test("counters track publish / inbound / encode path (direct vs json)", async () => {
    const server = createServer({ port: 0, inbound: ["trade"] });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url);
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(30);

    server.publish("quote", quote()); // direct path
    server.publish("order", emptyOrder); // JSON path (nested tables)
    client.send("trade", trade()); // inbound (allowed)
    await Bun.sleep(100);

    const m = server.getMetrics();
    expect(m.published).toBeGreaterThanOrEqual(2);
    expect(m.sent).toBeGreaterThanOrEqual(2);
    expect(m.inbound).toBeGreaterThanOrEqual(1);
    expect(m.inboundControl).toBeGreaterThanOrEqual(1); // the client's hello
    expect(m.connectedClients).toBe(1);
    expect(m.uptimeMs).toBeGreaterThanOrEqual(0);
    // encode-path observability
    expect(m.pathCounts["quote"]?.direct ?? 0).toBeGreaterThan(0);
    expect(m.pathCounts["order"]?.json ?? 0).toBeGreaterThan(0);

    client.close();
    server.stop();
  });

  test("protocol errors are counted (undecodable inbound frames)", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    await new Promise<void>((r) => (ws.onopen = () => r()));
    // send garbage as binary — the decoder rejects it and counts a protocol error
    ws.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02, 0x03]));
    await waitFor(() => server.getMetrics().protocolErrors >= 1);
    ws.close();
    server.stop();
  });
});

describe("/health", () => {
  test("returns a JSON snapshot with clients + uptime", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = new WebSocket(url);
    await new Promise<void>((r) => (ws.onopen = () => r()));

    const res = await fetch(`http://localhost:${server.port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { status: string; clients: number; uptimeMs: number };
    expect(body.status).toBe("ok");
    expect(body.clients).toBe(1);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);

    ws.close();
    server.stop();
  });
});
