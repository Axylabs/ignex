/**
 * Rooms / topic subscription tests (Phase 2):
 *   - client.subscribe() → server room membership → publishToTopic delivery
 *   - non-subscribers don't receive topic publishes; global publish still reaches all
 *   - unsubscribe stops delivery; topics() reflects live rooms
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

describe("rooms / topic subscriptions", () => {
  test("subscribe → publishToTopic reaches only subscribers; global publish reaches all", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const c1 = createClient(url);
    const c2 = createClient(url);
    const c1got: string[] = [];
    const c2got: string[] = [];
    c1.on("quote", (x) => c1got.push(x.symbol));
    c2.on("quote", (x) => c2got.push(x.symbol));
    c1.connect();
    c2.connect();
    await waitFor(() => server.clientCount === 2);

    c1.subscribe("equities");
    await waitFor(() => server.topics().includes("equities"));
    expect(server.topics()).toContain("equities");

    // topic publish → only the subscriber
    server.publishToTopic("equities", "quote", quote("AAPL"));
    await waitFor(() => c1got.includes("AAPL"));
    expect(c2got).not.toContain("AAPL");

    // global publish → both
    server.publish("quote", quote("MSFT"));
    await waitFor(() => c2got.includes("MSFT"));

    // unsubscribe → stops receiving topic publishes
    c1.unsubscribe("equities");
    await waitFor(() => !server.topics().includes("equities"));
    server.publishToTopic("equities", "quote", quote("NVDA"));
    await Bun.sleep(100);
    expect(c1got).not.toContain("NVDA");
    expect(server.topics()).not.toContain("equities");

    c1.close();
    c2.close();
    server.stop();
  });

  test("two topics are isolated from each other", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const a = createClient(url);
    const b = createClient(url);
    const agot: string[] = [];
    const bgot: string[] = [];
    a.on("quote", (x) => agot.push(x.symbol));
    b.on("quote", (x) => bgot.push(x.symbol));
    a.connect();
    b.connect();
    await waitFor(() => server.clientCount === 2);

    a.subscribe("topic-a");
    b.subscribe("topic-b");
    await waitFor(() => server.topics().length === 2);

    server.publishToTopic("topic-a", "quote", quote("A1"));
    server.publishToTopic("topic-b", "quote", quote("B1"));
    await waitFor(() => agot.includes("A1") && bgot.includes("B1"));
    expect(agot).not.toContain("B1");
    expect(bgot).not.toContain("A1");

    a.close();
    b.close();
    server.stop();
  });

  test("disconnecting a subscriber removes it from rooms (cleanup)", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;

    const c1 = createClient(url);
    const c2 = createClient(url);
    const got: string[] = [];
    c2.on("quote", (x) => got.push(x.symbol));
    c1.connect();
    c2.connect();
    await waitFor(() => server.clientCount === 2);

    c1.subscribe("temp");
    await waitFor(() => server.topics().includes("temp"));

    c1.close(); // disconnect the subscriber
    await waitFor(() => server.clientCount === 1);
    // room should be cleaned up (empty rooms are dropped)
    await waitFor(() => !server.topics().includes("temp"));

    // publishing to the dropped topic is a no-op (no subscribers)
    server.publishToTopic("temp", "quote", quote("GHOST"));
    await Bun.sleep(100);
    expect(got).not.toContain("GHOST");

    c2.close();
    server.stop();
  });
});
