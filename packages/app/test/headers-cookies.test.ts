/**
 * @fileoverview Compiled-server headers & cookies matrix.
 *
 * Header case-insensitivity / multi-values, cookie read + set, conditional
 * requests (ETag / If-None-Match → 304), byte ranges (206 / 416), and
 * Accept-Language negotiation. `sendFile` is used for the conditional/range
 * cases (it owns ETag/range handling).
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

describe("headers & cookies matrix (compiled server)", () => {
  it("echoes a custom request header", async () => {
    const res = await client.get("/headers", { headers: { "x-test": "hello" } });
    expect(await jsonBody(res)).toMatchObject({ headers: { "x-test": "hello" } });
  });

  it("reads headers case-insensitively", async () => {
    const res = await client.get("/headers", { headers: { "X-TEST": "uppercase" } });
    expect(await jsonBody(res)).toMatchObject({ headers: { "x-test": "uppercase" } });
  });

  it("preserves multi-value headers", async () => {
    const headers = new Headers();
    headers.append("x-multi", "a");
    headers.append("x-multi", "b");
    const res = await client.get("/headers", { headers });
    expect(await jsonBody(res)).toMatchObject({ headers: { "x-multi": "a, b" } });
  });

  it("reads cookies sent by the client", async () => {
    const res = await client.get("/cookies", { headers: { cookie: "theme=dark; sid=abc" } });
    const body = (await jsonBody(res)) as { seen: string[] };
    expect(body.seen.sort()).toEqual(["sid", "theme"]);
  });

  it("sets a response cookie", async () => {
    const res = await client.get("/cookies");
    expect(res.headers.get("set-cookie")).toContain("seen=1");
  });

  it("returns 304 for a matching If-None-Match (ETag)", async () => {
    const first = await client.get("/range");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const res = await client.get("/range", { headers: { "if-none-match": etag ?? "" } });
    expect(res.status).toBe(304);
  });

  it("serves a byte range with 206 and Content-Range", async () => {
    const res = await client.get("/range", { headers: { range: "bytes=0-9" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toMatch(/^bytes 0-9\//);
    expect(await res.text()).toHaveLength(10);
  });

  it("rejects an unsatisfiable range with 416", async () => {
    const res = await client.get("/range", { headers: { range: "bytes=999999-" } });
    expect(res.status).toBe(416);
  });

  it("negotiates the locale from Accept-Language", async () => {
    expect(
      await jsonBody(await client.get("/i18n", { headers: { "accept-language": "es" } })),
    ).toEqual({ locale: "es" });
    expect(
      await jsonBody(await client.get("/i18n", { headers: { "accept-language": "fr" } })),
    ).toEqual({ locale: "fr" });
    expect(await jsonBody(await client.get("/i18n"))).toEqual({ locale: "en" });
  });

  it("does not crash on a malformed Cookie header", async () => {
    const res = await client.get("/cookies", { headers: { cookie: "not-a-cookie;==; ;;;" } });
    expect(res.status).toBe(200);
  });
});
