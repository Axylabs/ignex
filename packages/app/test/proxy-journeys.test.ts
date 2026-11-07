/**
 * @fileoverview Proxy journeys (compiled server).
 *
 * The fixture's `/proxy?target=…` route forwards through `ctx.proxy(target, {
 * timeoutMs: 2000 })` — the `proxyRequest` contract in
 * `packages/core/src/http/proxy.ts`: pass-through of the upstream body and
 * headers (hop-by-hop stripped, `x-proxy: ignex` added), a 502
 * `{ error: "Bad Gateway", status: 502 }` envelope when the upstream is
 * unreachable, and a 504 `{ error: "Upstream timeout", status: 504 }` when it
 * exceeds the route's timeout. One fixture server is shared; the upstreams
 * live entirely in this file (a released dead port, a node:http upstream, and
 * a hanging upstream for the timeout lane).
 */
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;
/** Upstream servers closed in afterAll (keyed so the hang lane can be released). */
const upstreams: HttpServer[] = [];

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE);
  client = createClient(srv.base);
});

afterAll(async () => {
  srv.close();
  for (const server of upstreams) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Hanging keep-alive sockets (the timeout lane) must not hold the worker.
    server.closeAllConnections?.();
  }
});

/**
 * Minimal shape of an error probe. `createServer()` returns a fully-typed
 * `Server`, but the EventEmitter surface @types/node exposes on it varies by
 * version (v26 classes switched from `extends EventEmitter` to `implements`
 * without redeclaring `once`) — same workaround as `helpers/boot.ts`.
 */
interface ErrorProbe {
  once(event: "error", listener: (err: Error) => void): void;
}

/** Ask the OS for a currently-free TCP port, then release it (nothing listens). */
const freePort = (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    (probe as unknown as ErrorProbe).once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Start a node:http upstream on an OS-assigned port. */
const startUpstream = (
  handler: (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => void,
): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    const server = createHttpServer(handler);
    upstreams.push(server);
    (server as unknown as ErrorProbe).once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve(port);
    });
  });

const proxyGet = (target: string): Promise<Response> =>
  client.get(`/proxy?target=${encodeURIComponent(target)}`);

describe("proxy journeys (compiled server)", () => {
  it("returns the 502 Bad Gateway envelope for an upstream with no listener", async () => {
    const dead = await freePort();
    const res = await proxyGet(`http://127.0.0.1:${dead}/unreachable`);
    expect(res.status).toBe(502);
    expect(await jsonBody(res)).toEqual({ error: "Bad Gateway", status: 502 });
  });

  it("passes through the upstream body, content-type, and marks x-proxy", async () => {
    const port = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json+custom" });
      res.end(JSON.stringify({ upstream: true, note: "hello" }));
    });
    const res = await proxyGet(`http://127.0.0.1:${port}/echo`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json+custom");
    expect(res.headers.get("x-proxy")).toBe("ignex");
    expect(await jsonBody(res)).toEqual({ upstream: true, note: "hello" });
  });

  it("returns the 504 Gateway Timeout envelope when the upstream exceeds the route timeout", async () => {
    // /proxy forwards with `timeoutMs: 2000`; this upstream never answers.
    const port = await startUpstream(() => {
      /* hang — the proxy's abort signal must cut the request at ~2s */
    });
    const res = await proxyGet(`http://127.0.0.1:${port}/hang`);
    expect(res.status).toBe(504);
    expect(await jsonBody(res)).toEqual({ error: "Upstream timeout", status: 504 });
  }, 15_000);
});
