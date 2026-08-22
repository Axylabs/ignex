/**
 * NATS bridge tests (Phase 2/3) — deterministic, NO live NATS server. Uses a
 * fake `NatsTransport` so subject naming, frame-copy semantics, error
 * accounting, inbound decode/forward, the `inboundEvents` allowlist, server
 * wiring, loop prevention, and metrics folding are all exercised in CI.
 *
 * The real-NATS integration path is covered separately by
 * `test/nats-integration.test.ts` (opt-in via `NATS_URL`).
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { createNatsBridge, type NatsBridge, type NatsTransport } from "../src/bridge/nats";
import { encodeEvent } from "../src/transport/transport";
import { quote, trade, waitFor } from "./helpers";

/** Minimal NATS wildcard matcher (`>` = rest, `*` = one token). */
function matchSubject(pattern: string, subject: string): boolean {
  const p = pattern.split(".");
  const s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return true;
    if (p[i] === "*") continue;
    if (p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}

class FakeTransport implements NatsTransport {
  connected = true;
  published: Array<{ subject: string; data: Uint8Array }> = [];
  private subs: Array<{ subject: string; cb: (data: Uint8Array) => void }> = [];
  closed = false;

  publish(subject: string, data: Uint8Array): void {
    if (!this.connected) throw new Error("not connected");
    this.published.push({ subject, data: new Uint8Array(data) });
  }
  subscribe(subject: string, cb: (data: Uint8Array) => void): () => void {
    this.subs.push({ subject, cb });
    return () => {
      this.subs = this.subs.filter((s) => s.cb !== cb);
    };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  /** simulate an inbound NATS message on `subject` */
  emit(subject: string, data: Uint8Array): void {
    for (const s of this.subs) if (matchSubject(s.subject, subject)) s.cb(data);
  }
}

function bridgeOver(
  t: FakeTransport,
  opts: { inbound?: boolean; inboundEvents?: unknown[] } = {},
): NatsBridge {
  return createNatsBridge(
    { inbound: opts.inbound ?? false, inboundEvents: opts.inboundEvents as never },
    t,
  );
}

describe("NATS bridge (outbound)", () => {
  test("publish copies the frame (source reuse is safe) and counts bytes", () => {
    const t = new FakeTransport();
    const b = bridgeOver(t);
    const frame = new Uint8Array([1, 2, 3, 4, 5]);
    b.publish("ignex.broadcast.quote", frame);
    frame.fill(0xff); // clobber the source — the copy must be intact
    expect(t.published).toHaveLength(1);
    expect(t.published[0]!.subject).toBe("ignex.broadcast.quote");
    expect([...t.published[0]!.data]).toEqual([1, 2, 3, 4, 5]);
    expect(b.stats.bridged).toBe(1);
    expect(b.stats.bridgedBytes).toBe(5);
  });

  test("publish while NATS is down counts an error and never throws", () => {
    const t = new FakeTransport();
    t.connected = false;
    const b = bridgeOver(t);
    expect(() => b.publish("x.y", new Uint8Array([1]))).not.toThrow();
    expect(b.stats.bridgeErrors).toBe(1);
    expect(t.published).toHaveLength(0);
  });

  test("subject builder derives broadcast / topic / group / inbound subjects", () => {
    const b = bridgeOver(new FakeTransport(), {});
    expect(b.subjects.broadcast("quote")).toBe("ignex.broadcast.quote");
    expect(b.subjects.topic("equities", "quote")).toBe("ignex.topic.equities.quote");
    expect(b.subjects.group("premium", "quote")).toBe("ignex.group.premium.quote");
    expect(b.subjects.inboundPrefix()).toBe("ignex.inbound.>");
  });
});

describe("NATS bridge (inbound)", () => {
  test("inbound frames are decoded and forwarded to onInbound", () => {
    const t = new FakeTransport();
    const b = bridgeOver(t, { inbound: true });
    const got: Array<{ name: string; payload: unknown }> = [];
    b.setOnInbound((name, payload) => got.push({ name, payload }));

    t.emit("ignex.inbound.quote", encodeEvent("quote", quote("NATS-IN")));
    expect(got).toHaveLength(1);
    expect(got[0]!.name).toBe("quote");
    expect((got[0]!.payload as { symbol: string }).symbol).toBe("NATS-IN");
    expect(b.stats.bridgeInbound).toBe(1);
  });

  test("unknown ids and control frames are dropped (counted as errors)", () => {
    const t = new FakeTransport();
    const b = bridgeOver(t, { inbound: true });
    const got: unknown[] = [];
    b.setOnInbound((_name, payload) => got.push(payload));

    // unknown event id (0xffffffff) — readFrameHeader returns null
    t.emit("ignex.inbound.bogus", new Uint8Array([1, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
    // a real control frame (hello) — never forwarded
    t.emit("ignex.inbound.hello", encodeEvent("hello", { version: 1, caps: [], lastSeq: 0 }));
    expect(got).toHaveLength(0);
    expect(b.stats.bridgeInboundErrors).toBe(2);
  });

  test("inboundEvents allowlist filters which events are forwarded", () => {
    const t = new FakeTransport();
    const b = bridgeOver(t, { inbound: true, inboundEvents: ["quote"] });
    const got: unknown[] = [];
    b.setOnInbound((_name, payload) => got.push(payload));

    t.emit("ignex.inbound.quote", encodeEvent("quote", quote("Q1")));
    t.emit("ignex.inbound.trade", encodeEvent("trade", trade()));
    expect(got).toHaveLength(1);
    expect(b.stats.bridgeInbound).toBe(1);
  });
});

describe("server ↔ bridge wiring", () => {
  test("broadcast/topic/group publishes bridge with correct subjects + identical bytes; publishToClient does NOT bridge", async () => {
    const t = new FakeTransport();
    const bridge = bridgeOver(t, { inbound: true });
    const server = createServer({ port: 0, nats: bridge });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);
    await waitFor(() => c.clientId !== "");

    // broadcast → ignex.broadcast.<event>, bytes identical to the wire frame
    server.publish("quote", quote("BRD"));
    await waitFor(() => got.includes("BRD"));
    const brd = t.published.find((p) => p.subject === "ignex.broadcast.quote");
    expect(brd).toBeDefined();
    expect(brd!.data).toEqual(encodeEvent("quote", quote("BRD")));

    // topic → ignex.topic.<topic>.<event>
    server.publishToTopic("equities", "quote", quote("TOP"));
    expect(t.published.some((p) => p.subject === "ignex.topic.equities.quote")).toBe(true);

    // group → ignex.group.<group>.<event>
    server.joinGroup(c.clientId, "premium");
    server.publishToGroup("premium", "quote", quote("GRP"));
    expect(t.published.some((p) => p.subject === "ignex.group.premium.quote")).toBe(true);

    // targeted send to ONE client does NOT bridge
    const before = t.published.length;
    server.publishToClient(c.clientId, "quote", quote("DIRECT"));
    await waitFor(() => got.includes("DIRECT"));
    expect(t.published.length).toBe(before);

    c.close();
    server.stop();
  });

  test("inbound NATS events reach clients and are NOT re-bridged (no loop)", async () => {
    const t = new FakeTransport();
    const bridge = bridgeOver(t, { inbound: true });
    const server = createServer({ port: 0, nats: bridge });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);

    const before = t.published.length;
    t.emit("ignex.inbound.quote", encodeEvent("quote", quote("FROM-NATS")));
    await waitFor(() => got.includes("FROM-NATS"));
    expect(t.published.length).toBe(before); // forwarded to clients only

    c.close();
    server.stop();
  });

  test("getMetrics folds bridge stats + natsStatus", async () => {
    const t = new FakeTransport();
    const bridge = bridgeOver(t, { inbound: true });
    const server = createServer({ port: 0, nats: bridge });
    server.publish("quote", quote("M1"));
    const m = server.getMetrics();
    expect(m.natsStatus).toBe("connected");
    expect(m.bridged).toBe(1);
    expect(m.bridgedBytes).toBeGreaterThan(0);
    expect(m.bridgeInbound).toBe(0);
    expect(m.bridgeInboundErrors).toBe(0);
    server.stop();
  });
});
