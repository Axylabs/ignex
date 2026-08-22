/**
 * Server-side group targeting tests (Phase 1):
 *   - joinGroup / leaveGroup / publishToGroup fan-out (server-side targeting)
 *   - groups() / groupMembers() / clientGroups() introspection
 *   - empty groups are pruned
 *   - authenticate metadata can seed groups at connect
 *   - clients can join / leave groups via control frames (client.joinGroup)
 *   - groups have NO replay (unlike rooms) and never receive global publishes
 */
import { describe, expect, test } from "bun:test";
import { createClient } from "../public/client";
import { createServer } from "../public/server";
import { quote, waitFor } from "./helpers";

describe("server-side groups", () => {
  test("joinGroup / publishToGroup delivers only to members; leaveGroup prunes", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c1 = createClient(url);
    const c2 = createClient(url);
    const got1: string[] = [];
    const got2: string[] = [];
    c1.on("quote", (q) => got1.push(q.symbol));
    c2.on("quote", (q) => got2.push(q.symbol));
    c1.connect();
    c2.connect();
    await waitFor(() => server.clientCount === 2);
    await waitFor(() => c1.clientId !== "" && c2.clientId !== "");

    server.joinGroup(c1.clientId, "premium");
    expect(server.groups()).toEqual(["premium"]);
    expect(server.groupMembers("premium")).toEqual([c1.clientId]);
    expect(server.clientGroups(c1.clientId)).toEqual(["premium"]);
    expect(server.clientGroups(c2.clientId)).toEqual([]);

    server.publishToGroup("premium", "quote", quote("PG1"));
    await waitFor(() => got1.includes("PG1"));
    expect(got2).not.toContain("PG1");

    server.leaveGroup(c1.clientId, "premium");
    await waitFor(() => server.groups().length === 0); // empty group pruned
    server.publishToGroup("premium", "quote", quote("PG2"));
    await Bun.sleep(100);
    expect(got1).not.toContain("PG2");

    c1.close();
    c2.close();
    server.stop();
  });

  test("publishToGroup fans out to every member; group sends are NOT global", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const cs = [createClient(url), createClient(url), createClient(url)];
    const got = cs.map(() => [] as string[]);
    cs.forEach((c, i) => c.on("quote", (q) => got[i]!.push(q.symbol)));
    cs.forEach((c) => c.connect());
    await waitFor(() => server.clientCount === 3);
    await waitFor(() => cs.every((c) => c.clientId !== ""));

    for (const c of cs) server.joinGroup(c.clientId, "alpha");
    server.publishToGroup("alpha", "quote", quote("FANOUT"));
    await waitFor(() => got.every((g) => g.includes("FANOUT")));
    expect(server.groupMembers("alpha").length).toBe(3);

    // a client NOT in the group never sees it
    const outsider = createClient(url);
    const oGot: string[] = [];
    outsider.on("quote", (q) => oGot.push(q.symbol));
    outsider.connect();
    await waitFor(() => server.clientCount === 4);
    await waitFor(() => outsider.clientId !== "");
    server.publishToGroup("alpha", "quote", quote("FANOUT2"));
    await waitFor(() => got[0]!.includes("FANOUT2"));
    expect(oGot).not.toContain("FANOUT2");

    cs.forEach((c) => c.close());
    outsider.close();
    server.stop();
  });

  test("authenticate-seeded groups register at open and are cleaned up on close", async () => {
    const server = createServer({
      port: 0,
      authenticate: async () => ({ id: "g-user", groups: ["premium", "eu"] }),
    });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    c.connect();
    await waitFor(() => server.clientCount === 1);
    await waitFor(() => c.clientId === "g-user");

    expect(c.groups).toEqual(["premium", "eu"]);
    expect(server.clientGroups("g-user")).toEqual(["premium", "eu"]);
    expect(server.groups().sort()).toEqual(["eu", "premium"]);

    c.close();
    await waitFor(() => server.clientCount === 0);
    expect(server.groups()).toEqual([]);
    expect(server.groupMembers("premium")).toEqual([]);

    server.stop();
  });

  test("client-joinable groups via control frames", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const c = createClient(url);
    const got: string[] = [];
    c.on("quote", (q) => got.push(q.symbol));
    c.connect();
    await waitFor(() => server.clientCount === 1);
    await waitFor(() => c.clientId !== "");

    c.joinGroup("beta");
    await waitFor(() => server.groups().includes("beta"));
    server.publishToGroup("beta", "quote", quote("BG1"));
    await waitFor(() => got.includes("BG1"));

    c.leaveGroup("beta");
    await waitFor(() => server.groups().length === 0);
    server.publishToGroup("beta", "quote", quote("BG2"));
    await Bun.sleep(100);
    expect(got).not.toContain("BG2");

    c.close();
    server.stop();
  });

  test("groups have NO replay: a late joiner gets nothing", async () => {
    const server = createServer({ port: 0 });
    const url = `ws://localhost:${server.port}/ws`;
    const early = createClient(url);
    const late = createClient(url);
    const lateGot: string[] = [];
    late.on("quote", (q) => lateGot.push(q.symbol));
    early.connect();
    late.connect();
    await waitFor(() => server.clientCount === 2);
    await waitFor(() => early.clientId !== "" && late.clientId !== "");

    server.joinGroup(early.clientId, "premium");
    server.publishToGroup("premium", "quote", quote("BEFORE"));
    server.joinGroup(late.clientId, "premium");
    await Bun.sleep(100);
    expect(lateGot).not.toContain("BEFORE");

    early.close();
    late.close();
    server.stop();
  });
});
