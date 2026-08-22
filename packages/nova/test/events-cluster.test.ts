/**
 * Events layer — cluster / horizontal-scaling tests. Two server instances
 * share an in-memory `ClusterTransport` bus (and an optional shared state
 * store) so cross-instance behavior is deterministic in CI:
 *   - every emit target (broadcast / group / user / client) crosses instances
 *   - self-delivery dedupe (origin drops its own published frames)
 *   - presence without any shared state (join/leave/heartbeat messages)
 *   - shared-state indexes: user→clients, client groups, user groups, client data
 *   - server-side handlers for remote events (onServerEvent, source: "remote")
 *   - graceful close stops delivery
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { type ClusterTransport, createMemoryStateStore } from "../public/events";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

/** In-memory cluster bus: wildcard-subscribe (`x.>`), async delivery. */
class MemoryBus implements ClusterTransport {
  connected = true;
  private subs = new Map<string, Set<(d: Uint8Array) => void>>();
  publish(subject: string, data: Uint8Array): void {
    const copy = new Uint8Array(data);
    queueMicrotask(() => {
      for (const [pattern, cbs] of this.subs) {
        const match = pattern.endsWith(".>")
          ? subject.startsWith(pattern.slice(0, -1))
          : pattern === subject;
        if (match) for (const cb of cbs) cb(copy);
      }
    });
  }
  subscribe(subject: string, cb: (d: Uint8Array) => void): () => void {
    let set = this.subs.get(subject);
    if (!set) {
      set = new Set();
      this.subs.set(subject, set);
    }
    set.add(cb);
    return () => {
      const s = this.subs.get(subject);
      if (s) {
        s.delete(cb);
        if (s.size === 0) this.subs.delete(subject);
      }
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

function clusterPair(opts: { shared?: boolean } = {}) {
  const bus = new MemoryBus();
  const shared = opts.shared ? new Map<string, unknown>() : undefined;
  const events = (): object => ({
    cluster: {
      prefix: "t",
      transport: bus,
      ...(shared ? { state: createMemoryStateStore(shared) } : {}),
      heartbeatMs: 1000,
      presenceTtlMs: 4000,
    },
    global: false,
  });
  const s1 = createServer({ port: 0, events: events() });
  const s2 = createServer({ port: 0, events: events() });
  return {
    s1,
    s2,
    bus,
    url1: `ws://localhost:${s1.port}/ws`,
    url2: `ws://localhost:${s2.port}/ws`,
  };
}

async function connect(url: string) {
  const c = createClient(url);
  c.connect();
  await waitFor(() => c.clientId !== "");
  return c;
}

describe("events cluster — cross-instance delivery", () => {
  test("broadcast reaches clients on both instances exactly once", async () => {
    const { s1, s2, url1, url2 } = clusterPair();
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);

    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    s1.events!.emit("quote", quote("BROAD"));
    await waitFor(() => got1.includes("BROAD") && got2.includes("BROAD"));
    await Bun.sleep(100);
    expect(got1.filter((s) => s === "BROAD")).toHaveLength(1); // origin delivers once
    expect(got2.filter((s) => s === "BROAD")).toHaveLength(1);

    // origin dropped its own cluster frame (dedupe); remote frame arrived on the peer
    expect(s1.events!.metrics().clusterDroppedSelf).toBeGreaterThan(0);
    expect(s2.events!.metrics().clusterReceived).toBeGreaterThan(0);

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });

  test("emitToClient reaches a client hosted on the OTHER instance", async () => {
    const { s1, s2, url1, url2 } = clusterPair();
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);
    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    s1.events!.emitToClient(c2.clientId, "quote", quote("REMOTE-ONE"));
    await waitFor(() => got2.includes("REMOTE-ONE"));
    expect(got1).not.toContain("REMOTE-ONE");

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });

  test("emitToUser reaches the user's sockets on every instance", async () => {
    const { s1, s2, url1, url2 } = clusterPair();
    // c1 anonymous, c2 acts on behalf of "u-1"
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);
    s2.events!.setUserId(c2.clientId, "u-1");

    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    s1.events!.emitToUser("u-1", "quote", quote("TOU"));
    await waitFor(() => got2.includes("TOU"));
    await Bun.sleep(50);
    expect(got1).not.toContain("TOU");

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });

  test("emitToGroup reaches group members on every instance", async () => {
    const { s1, s2, url1, url2 } = clusterPair();
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    const outsider = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 2);
    s1.events!.group("g").add(c1.clientId);
    s2.events!.group("g").add(c2.clientId);

    const got1: string[] = [];
    const got2: string[] = [];
    const gotO: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));
    outsider.on("quote", (q) => gotO.push(q.symbol));

    s1.events!.emitToGroup("g", "quote", quote("GRP"));
    await waitFor(() => got1.includes("GRP") && got2.includes("GRP"));
    await Bun.sleep(50);
    expect(gotO).not.toContain("GRP");

    c1.close();
    c2.close();
    outsider.close();
    s1.stop();
    s2.stop();
  });
});

describe("events cluster — presence & shared state", () => {
  test("presence works WITHOUT shared state (join/leave messages)", async () => {
    const { s1, s2, url1, url2 } = clusterPair({ shared: false });
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);

    await waitFor(() => s1.events!.clusterClients().length === 1);
    expect(s1.events!.clusterClients()[0]!.clientId).toBe(c2.clientId);
    expect(s1.events!.clusterClients()[0]!.instanceId).toBe(s2.events!.instanceId);
    await waitFor(() => s2.events!.clusterClients().length === 1);
    expect(s2.events!.clusterClients()[0]!.clientId).toBe(c1.clientId);

    // disconnect → leave message → presence converges
    c2.close();
    await waitFor(() => s1.events!.clusterClients().length === 0);

    c1.close();
    s1.stop();
    s2.stop();
  });

  test("shared state: user→clients, client groups, user groups, client data across instances", async () => {
    const { s1, s2, url1, url2 } = clusterPair({ shared: true });
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);
    s2.events!.setUserId(c2.clientId, "u-1");
    s1.events!.setClientData(c1.clientId, "tier", "gold");

    // user → clients (both instances) — indexed via the shared state store (offloaded)
    {
      const t0 = Date.now();
      let list: Array<{ instanceId: string; clientId: string }> = [];
      while (Date.now() - t0 < 3000) {
        list = await s1.events!.clusterUserClients("u-1");
        if (list.length > 0) break;
        await Bun.sleep(10);
      }
      expect(list).toEqual([{ instanceId: s2.events!.instanceId, clientId: c2.clientId }]);
    }
    // client data written on s1 is readable on s2
    {
      const t0 = Date.now();
      let data: Record<string, unknown> | undefined;
      while (Date.now() - t0 < 3000) {
        data = await s2.events!.remoteClientData(c1.clientId);
        if (data !== undefined) break;
        await Bun.sleep(10);
      }
      expect(data).toMatchObject({ tier: "gold" });
    }
    // client-group membership syncs (control-frame join on s2 → visible on s1)
    {
      s2.events!.group("g").add(c2.clientId);
      const t0 = Date.now();
      let members: string[] = [];
      while (Date.now() - t0 < 3000) {
        members = await s1.events!.clusterGroupMembers("g");
        if (members.includes(c2.clientId)) break;
        await Bun.sleep(10);
      }
      expect(members).toContain(c2.clientId);
    }
    // user-group membership syncs
    {
      s1.events!.userGroup("admins").add("u-1");
      const t0 = Date.now();
      let members: string[] = [];
      while (Date.now() - t0 < 3000) {
        members = await s2.events!.clusterUserGroupMembers("admins");
        if (members.includes("u-1")) break;
        await Bun.sleep(10);
      }
      expect(members).toContain("u-1");
    }

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });

  test("server-side handlers receive REMOTE events (source: 'remote', no client)", async () => {
    const { s1, s2, url1, url2 } = clusterPair({ shared: false });
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);
    const got2: string[] = [];
    c2.on("quote", (q) => got2.push(q.symbol));

    const serverEvents: Array<{ symbol: string; source: string; hasClient: boolean }> = [];
    s2.events!.onServerEvent("quote", (payload, ctx) => {
      serverEvents.push({
        symbol: (payload as { symbol: string }).symbol,
        source: ctx.source,
        hasClient: ctx.client !== undefined,
      });
    });

    s1.events!.emitToClient(c2.clientId, "quote", quote("HANDLED"));
    await waitFor(() => got2.includes("HANDLED") && serverEvents.length === 1);
    expect(serverEvents[0]).toEqual({ symbol: "HANDLED", source: "remote", hasClient: false });

    // the ORIGIN instance never runs its own handler for its own emit
    const originHits: string[] = [];
    s1.events!.onServerEvent("quote", () => {
      originHits.push("x");
    });
    await Bun.sleep(50);
    expect(originHits).toEqual([]);

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });

  test("hub.close() stops delivery to that instance; the peer keeps working", async () => {
    const { s1, s2, url1, url2 } = clusterPair({ shared: false });
    const c1 = await connect(url1);
    const c2 = await connect(url2);
    await waitFor(() => s1.clientCount === 1 && s2.clientCount === 1);
    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));

    await s2.events!.close();
    s1.events!.emit("quote", quote("ONLY-S1"));
    await waitFor(() => got1.includes("ONLY-S1"));
    await Bun.sleep(100);
    expect(got2).not.toContain("ONLY-S1");

    c1.close();
    c2.close();
    s1.stop();
    s2.stop();
  });
});
