/**
 * Opt-in REAL-NATS integration tests. Skipped unless `NATS_URL` is set:
 *
 *   docker run --rm -p 4222:4222 nats          (or podman)
 *   NATS_URL=nats://localhost:4222 bun test test/nats-integration.test.ts
 *
 * Covers the full loop against a live NATS server: server → NATS frame
 * byte-identity, and NATS inbound → client forwarding.
 */
import { describe, expect, test } from "bun:test";
import { connect } from "nats";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { decodeFrame } from "../src/generated/registry";
import { quote, waitFor } from "./helpers";

const NATS_URL = process.env.NATS_URL;
const it = NATS_URL ? test : test.skip;

describe("NATS integration (real server)", () => {
  it("bridges identical frames to NATS and forwards inbound to clients", async () => {
    const server = createServer({
      port: 0,
      nats: { servers: [NATS_URL!], inbound: true, connectRetryMs: 250 },
    });
    await waitFor(() => server.getMetrics().natsStatus === "connected", 10_000);

    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);

    // 1) server publish → WS client receives AND a NATS consumer gets the same frame
    const nc = await connect({ servers: [NATS_URL!] });
    const sub = nc.subscribe("ignex.broadcast.quote");
    const received: Uint8Array[] = [];
    void (async () => {
      for await (const m of sub) received.push(new Uint8Array(m.data));
    })();
    await nc.flush(); // ensure the consumer SUB is registered before the publish

    server.publish("quote", quote("INTEG"));
    await waitFor(() => got.includes("INTEG") && received.length > 0, 10_000);

    // the bridged frame decodes to the same event the client got (same wire bytes)
    const decoded = decodeFrame(received[0]!);
    expect(decoded?.name).toBe("quote");
    expect((decoded!.payload as { symbol: string }).symbol).toBe("INTEG");

    // 2) publish into ignex.inbound.> → the server forwards it to clients
    nc.publish("ignex.inbound.quote", received[0]!);
    await nc.flush();
    await waitFor(() => got.filter((s) => s === "INTEG").length >= 2, 10_000);

    await nc.close();
    c.close();
    server.stop();
  });
});
