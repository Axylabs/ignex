/**
 * Auth / origin / limits tests (Phase 4):
 *   - pluggable authenticate() hook rejects unauthorized upgrades
 *   - built-in bearer-token helper (literal + predicate)
 *   - origin allowlist
 *   - maxConnections limit
 *   - maxMessageSize (oversized inbound frames close 1009 + count protocol error)
 */
import { describe, expect, test } from "bun:test";
import { createServer } from "../public/server";
import { tryConnect, waitFor } from "./helpers";

describe("authenticate hook", () => {
  test("rejects upgrades without the expected header", async () => {
    const server = createServer({
      port: 0,
      authenticate: (req) => req.headers.get("x-key") === "secret",
    });
    const url = `ws://localhost:${server.port}/ws`;

    expect(await tryConnect(url, { headers: { "x-key": "secret" } })).toBe(true);
    expect(await tryConnect(url, { headers: { "x-key": "wrong" } })).toBe(false);
    expect(await tryConnect(url, {})).toBe(false);

    // hold a persistent authorized connection and verify the server tracks it
    const ws = new WebSocket(url, { headers: { "x-key": "secret" } } as never);
    await new Promise<void>((r) => (ws.onopen = () => r()));
    expect(server.clientCount).toBe(1);
    ws.close();
    await waitFor(() => server.clientCount === 0);

    server.stop();
  });
});

describe("bearer-token helper", () => {
  test("literal token", async () => {
    const server = createServer({ port: 0, token: "s3cret" });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { authorization: "Bearer s3cret" } })).toBe(true);
    expect(await tryConnect(url, { headers: { authorization: "Bearer wrong" } })).toBe(false);
    expect(await tryConnect(url, {})).toBe(false);
    server.stop();
  });

  test("token predicate", async () => {
    const server = createServer({ port: 0, token: (t) => t.startsWith("valid-") });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { authorization: "Bearer valid-abc" } })).toBe(true);
    expect(await tryConnect(url, { headers: { authorization: "Bearer nope" } })).toBe(false);
    server.stop();
  });
});

describe("origin allowlist", () => {
  test("rejects disallowed origins", async () => {
    const server = createServer({ port: 0, allowedOrigins: ["http://localhost:3000"] });
    const url = `ws://localhost:${server.port}/ws`;
    expect(await tryConnect(url, { headers: { origin: "http://localhost:3000" } })).toBe(true);
    expect(await tryConnect(url, { headers: { origin: "http://evil.example" } })).toBe(false);
    server.stop();
  });
});

describe("connection + message limits", () => {
  test("maxConnections rejects beyond the limit", async () => {
    const server = createServer({ port: 0, maxConnections: 1 });
    const url = `ws://localhost:${server.port}/ws`;

    // hold the first connection OPEN so the limit is actually reached
    const ws1 = new WebSocket(url);
    await new Promise<void>((r) => (ws1.onopen = () => r()));
    expect(server.clientCount).toBe(1);

    expect(await tryConnect(url)).toBe(false); // second connection rejected
    expect(server.clientCount).toBe(1);

    ws1.close();
    await waitFor(() => server.clientCount === 0);
    server.stop();
  });

  test("maxMessageSize closes oversized inbound frames with 1009", async () => {
    const server = createServer({ port: 0, maxMessageSize: 32 });
    const url = `ws://localhost:${server.port}/ws`;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    let closeCode: number | undefined;
    ws.onclose = (ev) => {
      closeCode = ev.code;
    };
    await new Promise<void>((r) => (ws.onopen = () => r()));

    ws.send(new Uint8Array(4096).fill(1)); // oversized binary frame
    await waitFor(() => closeCode === 1009);
    await waitFor(() => server.getMetrics().protocolErrors >= 1);

    ws.close();
    server.stop();
  });
});
