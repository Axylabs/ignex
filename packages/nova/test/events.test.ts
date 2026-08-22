/**
 * Events layer tests (single instance) — the application-facing event-driven
 * surface on top of the FlatBuffer transport core:
 *   - `server.events` hub surface + the module-global emit singleton
 *   - emit targets (broadcast / client / user) with clear differentiation
 *   - client records ("who is connected, on whose behalf, what to remember")
 *   - client groups vs user groups
 *   - the events file: hub.on receives client-sent events with ctx
 *   - lifecycle, error isolation, metrics
 *
 * Cluster / horizontal-scaling sync is covered separately by
 * `test/events-cluster.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { bindEvents, emit, getEventsHub, isEventsBound, on, unbindEvents } from "../public/events";
import { createServer } from "../public/server";
import { quote, trade, waitFor } from "./helpers";

async function connectClient(url: string) {
  const c = createClient(url);
  c.connect();
  await waitFor(() => c.clientId !== "");
  return c;
}

describe("events layer — hub + global emit", () => {
  test("createServer({ events }) exposes server.events and binds the global singleton", () => {
    unbindEvents();
    expect(isEventsBound()).toBe(false);
    const server = createServer({ port: 0, events: {} });
    expect(server.events).toBeDefined();
    expect(isEventsBound()).toBe(true);
    expect(getEventsHub() === server.events).toBe(true);
    server.stop();
  });

  test("global emit sends events through websockets (broadcast)", async () => {
    unbindEvents();
    const server = createServer({ port: 0, events: {} });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = await connectClient(url);
    const c2 = await connectClient(url);
    await waitFor(() => server.clientCount === 2);

    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    emit("quote", quote("G1"));
    await waitFor(() => got1.includes("G1") && got2.includes("G1"));
    expect(server.getMetrics().events?.emitted).toBe(1);
    expect(server.getMetrics().events?.emittedByTarget.broadcast).toBe(1);

    c1.close();
    c2.close();
    server.stop();
  });

  test("global emit is typed and reachable from anywhere (the events file pattern)", async () => {
    unbindEvents();
    const server = createServer({ port: 0, events: {} });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));
    emit("quote", quote("FILE"));
    await waitFor(() => got.includes("FILE"));
    c.close();
    server.stop();
  });

  test("emit throws a descriptive error when no hub is bound", () => {
    unbindEvents();
    expect(() => emit("quote", quote())).toThrow(/no events hub bound/);
    // restore for subsequent tests
    const server = createServer({ port: 0, events: {} });
    expect(isEventsBound()).toBe(true);
    server.stop();
  });

  test("global on/once dispatch inbound events from clients", async () => {
    unbindEvents();
    const server = createServer({ port: 0, events: {} });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const seen: string[] = [];
    on("trade", (payload, ctx) => {
      seen.push(`${(payload as { symbol: string }).symbol}:${ctx.client?.id ?? "?"}`);
    });
    c.send("trade", trade({ symbol: "A" }));
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toBe(`A:${c.clientId}`);
    c.close();
    server.stop();
  });

  test("emitToClient reaches exactly one connection", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = await connectClient(url);
    const c2 = await connectClient(url);
    await waitFor(() => server.clientCount === 2);
    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    server.events!.emitToClient(c1.clientId, "quote", quote("ONE"));
    await waitFor(() => got1.includes("ONE"));
    expect(got2).not.toContain("ONE");
    expect(server.getMetrics().events?.emittedByTarget.client).toBe(1);

    c1.close();
    c2.close();
    server.stop();
  });

  test("emitToUser reaches every socket acting on behalf of the user (multi-device)", async () => {
    // two sockets, same userId (auto ids)
    const server = createServer({
      port: 0,
      events: { global: false },
      authenticate: async () => ({ userId: "user-7" }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const a = await connectClient(url);
    const b = await connectClient(url);
    await waitFor(() => server.events!.clientsByUser("user-7").length === 2);
    const gotA: string[] = [];
    const gotB: string[] = [];
    a.on("quote", (q) => gotA.push(q.symbol));
    b.on("quote", (q) => gotB.push(q.symbol));

    server.events!.emitToUser("user-7", "quote", quote("U"));
    await waitFor(() => gotA.includes("U") && gotB.includes("U"));

    // a user with NO live sockets never sees it
    server.events!.emitToUser("ghost-user", "quote", quote("U2"));
    await Bun.sleep(100);
    expect(gotA).not.toContain("U2");
    expect(gotB).not.toContain("U2");

    a.close();
    b.close();
    server.stop();
  });

  test("setUserId binds a connection to an identity; user index follows", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    expect(server.events!.client(c.clientId)?.userId).toBeUndefined();
    server.events!.setUserId(c.clientId, "u-late");
    expect(server.events!.client(c.clientId)?.userId).toBe("u-late");
    expect(server.events!.clientsByUser("u-late").map((x) => x.id)).toEqual([c.clientId]);
    // server introspection surfaces userId too
    expect(server.getClient(c.clientId)?.userId).toBe("u-late");
    c.close();
    server.stop();
  });
});

describe("events layer — client records & data", () => {
  test("onConnect seeds client data; setClientData/getClientData round-trip; close clears it", async () => {
    const server = createServer({
      port: 0,
      events: {
        global: false,
        onConnect: (client) => {
          client.data.set("session", `s-${client.id}`);
        },
      },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const rec = server.events!.client(c.clientId)!;
    expect(rec.data.get("session")).toBe(`s-${c.clientId}`);
    expect(server.events!.getClientData(c.clientId, "session")).toBe(`s-${c.clientId}`);

    server.events!.setClientData(c.clientId, "tier", "gold");
    expect(rec.data.get("tier")).toBe("gold");
    expect(rec.data.toJSON()).toEqual({ session: `s-${c.clientId}`, tier: "gold" });

    // clients() / clientCount reflect live connections
    expect(server.events!.clientCount).toBe(1);
    expect(server.events!.clients().map((x) => x.id)).toEqual([c.clientId]);

    c.close();
    await waitFor(() => server.events!.clientCount === 0);
    expect(server.events!.client(c.clientId)).toBeUndefined();
    expect(server.events!.getClientData(c.clientId, "tier")).toBeUndefined(); // record gone → data gone
    server.stop();
  });

  test("authenticate { id, userId, groups } seeds the client record", async () => {
    const server = createServer({
      port: 0,
      events: { global: false },
      authenticate: async () => ({
        id: "fixed-id",
        userId: "fixed-user",
        groups: ["eu"],
        meta: { role: "trader" },
      }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    await waitFor(() => c.clientId === "fixed-id");
    const rec = server.events!.client("fixed-id")!;
    expect(rec.userId).toBe("fixed-user");
    expect(rec.meta).toEqual({ role: "trader" });
    expect([...rec.groups]).toEqual(["eu"]);
    c.close();
    server.stop();
  });
});

describe("events layer — groups (differentiated targeting)", () => {
  test("client groups: add/remove/members/has/size/emit", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = await connectClient(url);
    const c2 = await connectClient(url);
    await waitFor(() => server.clientCount === 2);
    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    const g = server.events!.group("premium");
    g.add(c1.clientId);
    expect(g.has(c1.clientId)).toBe(true);
    expect(g.has(c2.clientId)).toBe(false);
    expect(g.members()).toEqual([c1.clientId]);
    expect(g.size).toBe(1);
    expect(server.events!.groups()).toEqual(["premium"]);

    g.emit("quote", quote("PG"));
    await waitFor(() => got1.includes("PG"));
    expect(got2).not.toContain("PG");

    g.remove(c1.clientId);
    await waitFor(() => g.size === 0);
    expect(server.events!.groups()).toEqual([]);

    c1.close();
    c2.close();
    server.stop();
  });

  test("user groups: membership by userId, emit to every socket of member users", async () => {
    const server = createServer({
      port: 0,
      events: { global: false },
      authenticate: async () => ({ userId: "trader-1" }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const a = await connectClient(url);
    const b = await connectClient(url); // second socket of trader-1
    await waitFor(() => server.events!.clientsByUser("trader-1").length === 2);

    const ug = server.events!.userGroup("admins");
    ug.add("trader-1");
    expect(ug.members()).toEqual(["trader-1"]);
    expect(server.events!.userGroups()).toEqual(["admins"]);

    const gotA: string[] = [];
    const gotB: string[] = [];
    a.on("quote", (q) => gotA.push(q.symbol));
    b.on("quote", (q) => gotB.push(q.symbol));
    ug.emit("quote", quote("ADMIN"));
    await waitFor(() => gotA.includes("ADMIN") && gotB.includes("ADMIN")); // both sockets

    ug.remove("trader-1");
    expect(ug.has("trader-1")).toBe(false);
    expect(server.events!.userGroups()).toEqual([]);

    a.close();
    b.close();
    server.stop();
  });
});

describe("events layer — the events file (receiving events)", () => {
  test("hub.on receives client-sent events with ctx.client; multiple handlers; off; once", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);

    const order: string[] = [];
    const h1 = (payload: { symbol: string }, ctx: { client?: { id: string } }): void => {
      order.push(`h1:${payload.symbol}:${ctx.client?.id}`);
    };
    const h2 = (payload: { symbol: string }): void => {
      order.push(`h2:${payload.symbol}`);
    };
    server.events!.on("trade", h1);
    server.events!.on("trade", h2);
    expect(server.events!.listenerCount("trade")).toBe(2);
    expect(server.events!.events()).toContain("trade");

    c.send("trade", trade({ symbol: "X" }));
    await waitFor(() => order.length === 2);
    expect(order).toEqual([`h1:X:${c.clientId}`, "h2:X"]);

    server.events!.off("trade", h1);
    c.send("trade", trade({ symbol: "Y" }));
    await waitFor(() => order.length === 3);
    expect(order[2]).toBe("h2:Y");

    // once fires exactly once
    let onceCount = 0;
    server.events!.once("trade", () => {
      onceCount++;
    });
    c.send("trade", trade({ symbol: "Z1" }));
    await waitFor(() => onceCount === 1);
    c.send("trade", trade({ symbol: "Z2" }));
    await Bun.sleep(50);
    expect(onceCount).toBe(1);

    c.close();
    server.stop();
  });

  test("onAny sees every inbound event (allowed via the inbound option)", async () => {
    const server = createServer({
      port: 0,
      events: { global: false, inbound: ["quote", "trade"] },
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const seen: string[] = [];
    server.events!.onAny((name, payload, ctx) => {
      seen.push(`${name}:${(payload as { symbol?: string }).symbol ?? ""}:${ctx.source}`);
    });
    c.send("quote", quote("QA"));
    c.send("trade", trade({ symbol: "TA" }));
    await waitFor(() => seen.length === 2);
    expect(seen.sort()).toEqual(["quote:QA:client", "trade:TA:client"]);
    c.close();
    server.stop();
  });

  test("handler errors are isolated and counted; the other handlers still run", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const ran: string[] = [];
    server.events!.on("trade", () => {
      throw new Error("boom");
    });
    server.events!.on("trade", (payload: { symbol: string }) => {
      ran.push(payload.symbol);
    });
    c.send("trade", trade({ symbol: "OK" }));
    await waitFor(() => ran.length === 1);
    expect(ran).toEqual(["OK"]);
    expect(server.events!.metrics().handlerErrors).toBe(1);
    c.close();
    server.stop();
  });

  test("emit after hub.close() is a silent no-op; global emit throws once unbound", async () => {
    unbindEvents();
    const server = createServer({ port: 0, events: {} }); // binds the global
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));

    await server.events!.close();
    server.events!.emit("quote", quote("AFTER")); // no-op, no throw
    await Bun.sleep(50);
    expect(got).not.toContain("AFTER");
    expect(isEventsBound()).toBe(false);
    expect(() => emit("quote", quote())).toThrow(/no events hub bound/);

    // a later server rebinds
    const s2 = createServer({ port: 0, events: {} });
    expect(isEventsBound()).toBe(true);
    expect(getEventsHub() === s2.events).toBe(true);
    // manual rebind is also supported
    bindEvents(server.events!);
    expect(getEventsHub() === server.events).toBe(true);
    unbindEvents();
    c.close();
    server.stop();
    s2.stop();
  });

  test("metrics and queue stats are observable", async () => {
    const server = createServer({ port: 0, events: { global: false } });
    const url = `ws://localhost:${server.port}/ws`;
    const c = await connectClient(url);
    await waitFor(() => server.clientCount === 1);
    server.events!.emit("quote", quote("M1"));
    server.events!.emitToClient(c.clientId, "quote", quote("M2"));
    await waitFor(() => server.getMetrics().events?.emitted === 2);

    const m = server.getMetrics().events!;
    expect(m.emittedByTarget.broadcast).toBe(1);
    expect(m.emittedByTarget.client).toBe(1);
    expect(m.deliveredLocal).toBe(2);
    expect(m.connectedClients).toBe(1);
    expect(server.events!.queueStats().queued).toBe(0); // no cluster → nothing queued
    c.close();
    server.stop();
  });
});
