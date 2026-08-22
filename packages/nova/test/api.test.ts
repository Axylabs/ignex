/**
 * Client API-breadth tests (Phase 9): once / onAny / events() / removeAllListeners.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import type { Events } from "../src/schema";
import { quote, trade, waitFor } from "./helpers";

describe("client API breadth", () => {
  test("once fires exactly once", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url);
    let count = 0;
    client.once("quote", () => count++);
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(30);

    server.publish("quote", quote("A"));
    await waitFor(() => count === 1);
    server.publish("quote", quote("B"));
    server.publish("quote", quote("C"));
    await Bun.sleep(100);
    expect(count).toBe(1); // fired once despite three publishes

    client.close();
    server.stop();
  });

  test("onAny receives every event name + payload", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url);
    const seen: string[] = [];
    client.onAny((name, payload) =>
      seen.push(`${name}:${(payload as Events["quote"]).symbol ?? ""}`),
    );
    client.on("quote", () => {});
    client.connect();
    await waitFor(() => server.clientCount === 1);
    await Bun.sleep(30);

    server.publish("quote", quote("X"));
    server.publish("trade", trade());
    await waitFor(() => seen.length >= 2);
    expect(seen).toContain("quote:X");
    expect(seen.some((s) => s.startsWith("trade:"))).toBe(true);

    client.close();
    server.stop();
  });

  test("events() lists names with handlers; removeAllListeners clears them", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const client = createClient(url);
    client.on("quote", () => {});
    client.on("trade", () => {});
    expect(client.events().sort()).toEqual(["quote", "trade"]);

    client.removeAllListeners("quote");
    expect(client.events()).toEqual(["trade"]);

    client.removeAllListeners();
    expect(client.events()).toEqual([]);

    server.stop();
  });

  test("onError surfaces undecodable frames", async () => {
    // A raw server that sends a garbage binary frame on open — the client's
    // decoder rejects it and routes the failure to onError.
    const fake = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (srv.upgrade(req)) return undefined;
        return new Response("x");
      },
      websocket: {
        open(ws) {
          ws.send(new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x01, 0x02])); // undecodable
        },
        message() {},
      },
    });
    const client = createClient(`ws://localhost:${fake.port}/ws`);
    const errors: Error[] = [];
    client.onError((e) => errors.push(e));
    client.connect();
    await waitFor(() => errors.length >= 1);
    expect(errors[0]!.message).toContain("frame dropped");
    client.close();
    fake.stop(true);
  });
});
