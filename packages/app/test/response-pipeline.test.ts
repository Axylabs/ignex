/**
 * @fileoverview Compiled-server response pipeline matrix.
 *
 * Non-success responses (thrown errors, guard halts) must run the response
 * pipeline exactly like a 200: plugins decorate them (CORS echo, security),
 * and `ctx.query` keeps the URLSearchParams contract when no query schema is
 * declared. Both regressions were invisible in the happy-path suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot";
import { createClient, jsonBody, type TestClient } from "./helpers/http";

let srv: BootedServer;
let client: TestClient;

beforeAll(async () => {
  srv = await bootServer(MATRIX_FIXTURE, { rebuild: true });
  client = createClient(srv.base);
}, 120_000);

afterAll(() => srv.close());

const origin = "https://app.example";

describe("response pipeline (compiled server)", () => {
  it("decorates a thrown HTTP error with plugin response headers", async () => {
    const res = await client.get("/http-error", { headers: { origin } });

    expect(res.status).toBe(422);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(await jsonBody(res)).toMatchObject({ status: 422, code: "NOPE" });
  });

  it("decorates a guard halt with plugin response headers", async () => {
    const res = await client.get("/halted", { headers: { origin } });

    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe(origin);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("keeps ctx.query as URLSearchParams without a query schema", async () => {
    const res = await client.get("/query-contract?q=hello");

    expect(res.status).toBe(200);
    expect(await jsonBody(res)).toEqual({ value: "hello" });
  });
});
