/**
 * Client registry + targeted delivery tests (Phase 1):
 *   - every connection gets an id (auth metadata or auto-UUID) exposed via
 *     getClient/getClients AND delivered to the client in the `welcome` frame
 *   - publishToClient delivers only to the addressed client; false when offline
 *   - disconnectClient closes the socket and removes it from the registry
 *   - duplicate explicit ids are rejected (409) at upgrade
 *   - GET /clients returns a JSON snapshot of active clients
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

/** Open a WebSocket with custom headers; resolves to the ws (kept open) or null. */
function openWith(url: string, headers: Record<string, string>): Promise<WebSocket | null> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers } as never);
    let settled = false;
    const done = (v: WebSocket | null): void => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    ws.onopen = () => done(ws);
    ws.onerror = () => done(null);
    ws.onclose = () => done(null);
    setTimeout(() => done(null), 2000);
  });
}

describe("client registry + targeted sends", () => {
  test("every connection gets a distinct auto-UUID visible via getClients + client.clientId", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = createClient(url);
    const c2 = createClient(url);
    c1.connect();
    c2.connect();
    await waitFor(() => server.clientCount === 2);

    const clients = server.getClients();
    expect(clients).toHaveLength(2);
    expect(new Set(clients.map((c) => c.id)).size).toBe(2);

    // the server pushed each id to its client in the `welcome` control frame
    await waitFor(() => c1.clientId !== "" && c2.clientId !== "");
    expect(new Set([c1.clientId, c2.clientId]).size).toBe(2);
    expect(server.getClient(c1.clientId)?.id).toBe(c1.clientId);

    c1.close();
    c2.close();
    server.stop();
  });

  test("publishToClient delivers only to the addressed client; false for offline ids", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = createClient(url);
    const c2 = createClient(url);
    const got: string[] = [];
    c1.on("quote", (q) => got.push(q.symbol));
    c1.connect();
    c2.connect();
    await waitFor(() => server.clientCount === 2);
    await waitFor(() => c1.clientId !== "" && c2.clientId !== "");

    expect(server.publishToClient(c1.clientId, "quote", quote("TGT1"))).toBe(true);
    await waitFor(() => got.includes("TGT1"));
    expect(server.publishToClient("no-such-id", "quote", quote("X"))).toBe(false);

    c1.close();
    c2.close();
    server.stop();
  });

  test("disconnectClient closes the socket and removes it from the registry", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);
    await waitFor(() => c.clientId !== "");

    expect(server.disconnectClient(c.clientId)).toBe(true);
    await waitFor(() => server.clientCount === 0);
    expect(server.getClient(c.clientId)).toBeUndefined();
    expect(server.disconnectClient(c.clientId)).toBe(false);

    server.stop();
  });

  test("authenticate may pin id/groups/meta; duplicate explicit id is rejected (409)", async () => {
    const server = createServer({
      port: 0,
      authenticate: async (req) => {
        const who = req.headers.get("x-user") ?? "";
        if (!who) return false;
        return { id: who, groups: ["premium"], meta: { plan: "pro" } };
      },
    });
    const url = `ws://localhost:${server.port}/ws`;

    const first = await openWith(url, { "x-user": "u1" });
    expect(first).not.toBeNull();
    await waitFor(() => server.clientCount === 1);
    const info = server.getClient("u1");
    expect(info?.groups).toEqual(["premium"]);
    expect(info?.meta).toEqual({ plan: "pro" });
    expect(info?.id).toBe("u1");

    // a second connection claiming the same id is rejected while the first lives
    const second = await openWith(url, { "x-user": "u1" });
    expect(second).toBeNull();
    expect(server.clientCount).toBe(1);

    first?.close();
    server.stop();
  });

  test("GET /clients returns a JSON snapshot of active clients", async () => {
    const server = createServer({
      port: 0,
      authenticate: async () => ({ id: "admin-session", meta: { role: "admin" } }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);

    const res = await fetch(`http://localhost:${server.port}/clients`);
    const body = (await res.json()) as { id: string; groups: string[] }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.id).toBe("admin-session");
    expect(Array.isArray(body[0]!.groups)).toBe(true);

    c.close();
    server.stop();
  });
});
