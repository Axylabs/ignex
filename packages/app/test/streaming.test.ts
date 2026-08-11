/**
 * @fileoverview Compiled-server streaming matrix.
 *
 * SSE framing, large streaming downloads, proxying (200 / 502), and file
 * serving via `sendFile`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE);
  client = createClient(srv.base);
});

afterAll(() => srv.close());

describe("streaming matrix (compiled server)", () => {
  it("streams Server-Sent Events with correct framing", async () => {
    const res = await client.get("/sse");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const text = await res.text();
    expect(text).toContain("event: ping");
    expect(text).toContain("data: 1");
    expect(text).toContain("event: done");
    expect(text).toContain("data: bye");
  });

  it("streams a large download of exactly 1 MiB", async () => {
    const res = await client.get("/download");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/octet-stream");

    const buf = await res.arrayBuffer();
    expect(buf.byteLength).toBe(1024 * 1024);
  });

  it("proxies to an upstream URL and returns its body", async () => {
    const target = encodeURIComponent(`${srv.base}/static`);
    const res = await client.get(`/proxy?target=${target}`);
    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ static: true });
  });

  it("proxies a 502 when the upstream is unreachable", async () => {
    const target = encodeURIComponent("http://127.0.0.1:1/unreachable");
    const res = await client.get(`/proxy?target=${target}`);
    expect(res.status).toBe(502);
  });

  it("requires a target for the proxy route (400)", async () => {
    const res = await client.get("/proxy");
    expect(res.status).toBe(400);
  });

  it("serves a file with sendFile including an ETag", async () => {
    const res = await client.get("/range");
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBeTruthy();
  });
});
