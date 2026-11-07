/**
 * @fileoverview Server-Sent Events client-lifecycle journeys (compiled server).
 *
 * `streaming.test.ts` proves SSE FRAMING on the fast `/sse` route; these
 * journeys prove the CONNECTION lifecycle against the paced `/sse-slow` route
 * (one `tick` every 30ms, so a client can abort mid-stream):
 *
 *  - reading N events then client-aborting must leave the server healthy and
 *    the route immediately reusable (no leaked connection/generator);
 *  - a rapid connect/disconnect loop must not wedge the server;
 *  - after all that churn the fast `/sse` route still streams to completion.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE);
  client = createClient(srv.base);
});

afterAll(() => srv.close());

/**
 * Read the next `count` SSE `data:` payloads from a streaming response.
 * Frames are `event: …\n data: …\n\n`; only the data line is asserted here.
 */
const readEvents = async (res: Response, count: number): Promise<string[]> => {
  const reader = res.body?.getReader();
  if (!reader) throw new Error("SSE response has no body stream");
  const decoder = new TextDecoder();
  let buffer = "";
  const events: string[] = [];
  while (events.length < count) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const boundary = buffer.indexOf("\n\n");
      if (boundary < 0) break;
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data.length > 0) events.push(data);
    }
  }
  reader.releaseLock();
  return events;
};

describe("SSE journeys (compiled server)", () => {
  it("reads N paced events then client-aborts; server stays healthy and the route still works", async () => {
    const controller = new AbortController();
    const res = await client.get("/sse-slow", { signal: controller.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const events = await readEvents(res, 3);
    expect(events).toEqual(["1", "2", "3"]);

    // Abort mid-stream (the route still has ~47 pending ticks).
    controller.abort();

    // The aborted stream must not wedge the server…
    const health = await client.get("/health");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });

    // …and the SSE route itself must stream again immediately (no leak).
    const again = await client.get("/sse-slow", { signal: AbortSignal.timeout(5_000) });
    expect(again.status).toBe(200);
    expect(await readEvents(again, 1)).toEqual(["1"]);
    // Release the still-open stream so the socket returns to the pool.
    await again.body?.cancel();
  });

  it("survives a rapid connect/disconnect loop (5×) and stays healthy", async () => {
    for (let i = 0; i < 5; i++) {
      const controller = new AbortController();
      const res = await client.get("/sse-slow", { signal: controller.signal });
      expect(res.status).toBe(200);
      // One event proves the stream is live, then disconnect.
      expect(await readEvents(res, 1)).toEqual(["1"]);
      controller.abort();
    }
    const health = await client.get("/health");
    expect(health.status).toBe(200);
  });

  it("still streams the fast /sse route to completion after the aborts", async () => {
    const res = await client.get("/sse");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("event: ping");
    expect(text).toContain("event: done");
    expect(text).toContain("data: bye");
  });
});
