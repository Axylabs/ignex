/**
 * Reconnect / heartbeat / replay tests (Phase 5):
 *   - reconnect with backoff: status transitions + resumes receiving after a
 *     server restart on the same port
 *   - auto-resubscribe: topic membership is restored after reconnect
 *   - last-value replay: subscribing delivers the recorded topic history
 *     (oldest → newest) — the "reconnect with state" path
 *   - heartbeat: app-level pings keep the connection alive and detected
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

describe("reconnect with backoff", () => {
  test("status transitions + resumes receiving after a server restart", async () => {
    const port = 5100 + Math.floor(Math.random() * 400);
    let server = createServer({ port });
    const url = `ws://localhost:${port}/ws`;

    const statuses: string[] = [];
    const got: string[] = [];
    const client = createClient(url, {
      reconnect: { initialDelay: 50, maxDelay: 250, jitter: false },
    });
    client.onStatus((s) => statuses.push(s));
    client.on("quote", (x) => got.push(x.symbol));
    client.connect();
    await waitFor(() => server.clientCount === 1);

    server.publish("quote", quote("BEFORE"));
    await waitFor(() => got.includes("BEFORE"));

    // restart the server → the client disconnects and reconnects to the same url
    server.stop(true);
    await waitFor(() => statuses.includes("reconnecting"));
    await Bun.sleep(80); // let the port free up
    server = createServer({ port });
    await waitFor(() => server.clientCount === 1); // client reconnected

    server.publish("quote", quote("AFTER"));
    await waitFor(() => got.includes("AFTER"));

    expect(statuses).toContain("connected");
    expect(statuses).toContain("disconnected");
    expect(statuses).toContain("reconnecting");
    expect(statuses.filter((s) => s === "connected").length).toBeGreaterThanOrEqual(2);

    client.close();
    server.stop();
  });

  test("auto-resubscribe restores topic membership after reconnect", async () => {
    const port = 5600 + Math.floor(Math.random() * 400);
    let server = createServer({ port });
    const url = `ws://localhost:${port}/ws`;

    const got: string[] = [];
    const client = createClient(url, {
      reconnect: { initialDelay: 50, maxDelay: 250, jitter: false },
    });
    client.on("quote", (x) => got.push(x.symbol));
    client.connect();
    await waitFor(() => server.clientCount === 1);
    client.subscribe("equities");
    await waitFor(() => server.topics().includes("equities"));
    server.publishToTopic("equities", "quote", quote("T1"));
    await waitFor(() => got.includes("T1"));

    server.stop(true);
    await Bun.sleep(80);
    server = createServer({ port });
    await waitFor(() => server.clientCount === 1);
    await waitFor(() => server.topics().includes("equities")); // auto re-subscribed
    server.publishToTopic("equities", "quote", quote("T2"));
    await waitFor(() => got.includes("T2"));

    client.close();
    server.stop();
  });
});

describe("last-value replay", () => {
  test("subscribing delivers the recorded topic history (oldest → newest)", async () => {
    const server = createServer({ port: 0, replay: { historySize: 5 } });
    const url = `ws://localhost:${server.port}/ws`;

    // publish BEFORE any subscriber — history records the frames
    server.publishToTopic("equities", "quote", quote("A"));
    server.publishToTopic("equities", "quote", quote("B"));
    server.publishToTopic("equities", "quote", quote("C"));

    const client = createClient(url);
    const got: string[] = [];
    client.on("quote", (x) => got.push(x.symbol));
    client.connect();
    await waitFor(() => server.clientCount === 1);
    client.subscribe("equities");

    await waitFor(() => got.length >= 3);
    expect(got.slice(0, 3)).toEqual(["A", "B", "C"]); // in order

    client.close();
    server.stop();
  });

  test("replay is bounded by historySize (older frames are dropped)", async () => {
    const server = createServer({ port: 0, replay: { historySize: 2 } });
    const url = `ws://localhost:${server.port}/ws`;
    server.publishToTopic("t", "quote", quote("W"));
    server.publishToTopic("t", "quote", quote("X"));
    server.publishToTopic("t", "quote", quote("Y"));
    server.publishToTopic("t", "quote", quote("Z"));

    const client = createClient(url);
    const got: string[] = [];
    client.on("quote", (x) => got.push(x.symbol));
    client.connect();
    await waitFor(() => server.clientCount === 1);
    client.subscribe("t");

    await waitFor(() => got.length >= 2);
    expect(got.slice(0, 2)).toEqual(["Y", "Z"]); // only the last 2 replayed

    client.close();
    server.stop();
  });
});

describe("heartbeat", () => {
  test("app-level pings keep the connection alive and answered", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url, { heartbeatMs: 50, heartbeatMisses: 2 });
    client.connect();
    await waitFor(() => server.clientCount === 1);

    const before = server.getMetrics().inboundControl;
    await Bun.sleep(250); // several heartbeat intervals
    const after = server.getMetrics().inboundControl;

    expect(after).toBeGreaterThan(before); // pings arrived (server answered pongs)
    expect(client.currentStatus).toBe("connected"); // still alive

    client.close();
    server.stop();
  });
});
