/**
 * @fileoverview Compiled-server routing matrix.
 *
 * Exercises the AOT-generated route table (Bun native router + ignex helpers):
 * static / dynamic / wildcard / nested paths, 404 / 405 + Allow, auto-OPTIONS
 * and auto-HEAD, query strings, and `ctx.route` population. Table-driven so new
 * cases are cheap to add.
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

describe("routing matrix (compiled server)", () => {
  it.each([
    ["/health", 200],
    ["/static", 200],
    ["/search", 200],
    ["/does-not-exist", 404],
    ["/users/42/posts/7/extra", 404],
    ["/", 404],
  ])("GET %s → %i", async (path, expected) => {
    expect((await client.get(path)).status).toBe(expected);
  });

  it("serves a dynamic param route", async () => {
    const res = await client.get("/users/42");
    expect(await jsonBody(res)).toEqual({ id: "42" });
  });

  it("serves nested dynamic params", async () => {
    const res = await client.get("/users/42/posts/7");
    expect(await jsonBody(res)).toEqual({ id: "42", postId: "7" });
  });

  it("serves a wildcard (catch-all) route with the captured suffix", async () => {
    const res = await client.get("/files/a/b/c.txt");
    expect(await jsonBody(res)).toEqual({ path: "a/b/c.txt" });
  });

  it("URL-decodes wildcard captures", async () => {
    const res = await client.get("/files/a%20b/c.txt");
    expect(await jsonBody(res)).toEqual({ path: "a b/c.txt" });
  });

  it("echoes the query string", async () => {
    const res = await client.get("/search?a=1&b=two");
    expect(await jsonBody(res)).toEqual({
      query: { a: "1", b: "two" },
      raw: [
        ["a", "1"],
        ["b", "two"],
      ],
    });
  });

  it("preserves duplicate query keys (both reach the handler)", async () => {
    const res = await client.get("/search?q=1&q=2");
    const body = (await jsonBody(res)) as { raw: [string, string][] };
    expect(body.raw).toEqual([
      ["q", "1"],
      ["q", "2"],
    ]);
  });

  it("answers 405 with an Allow header for a disallowed method", async () => {
    const res = await client.post("/static", "x");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET,HEAD,OPTIONS");
  });

  it("405s a disallowed method on a dynamic route", async () => {
    expect((await client.del("/users/42")).status).toBe(405);
  });

  it("auto-answers OPTIONS with 204 and Allow", async () => {
    const res = await client.options("/static");
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET,HEAD,OPTIONS");
  });

  it("auto-answers HEAD with an empty body for GET routes", async () => {
    const res = await client.head("/static");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    // The auto-HEAD strips the GET body; content-length is the client-side
    // artifact of an empty body (0) rather than the GET body size.
    expect(res.headers.get("content-length")).toBe("0");
  });

  it.each(["GET", "POST", "PUT", "PATCH", "DELETE"] as const)(
    "accepts every method on the ALL route (%s /echo)",
    async (method) => {
      const res = await client.request(method, "/echo");
      expect(res.status).toBe(200);
      expect((await jsonBody(res)) as { method?: string }).toMatchObject({
        method,
        path: "/echo",
      });
    },
  );

  it("populates ctx.route with the matched pattern", async () => {
    const res = await client.get("/routeinfo/42");
    expect(await jsonBody(res)).toEqual({ route: "/routeinfo/:id", id: "42" });
  });
});
