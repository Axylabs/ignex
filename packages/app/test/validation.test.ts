/**
 * @fileoverview Compiled-server validation & serialization matrix.
 *
 * Ajv-based request validation (query / params / headers / body) with
 * coercion, the 422 error envelope, and status-keyed response serialization
 * (200/201) via the precompiled serializers.
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

const json = { "content-type": "application/json" };

describe("validation matrix (compiled server)", () => {
  it("validates and coerces a valid query", async () => {
    const res = await client.get("/validate-query?q=hi&n=5");
    expect(await jsonBody(res)).toEqual({ query: { q: "hi", n: 5 } });
  });

  it("rejects a missing required query field with a 422 envelope", async () => {
    const res = await client.get("/validate-query");
    expect(res.status).toBe(422);
    const body = (await jsonBody(res)) as { status?: number; code?: string };
    expect(body.status).toBe(422);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("coerces a numeric route param", async () => {
    const res = await client.get("/validate-params/42");
    expect(await jsonBody(res)).toEqual({ id: 42, type: "number" });
  });

  it("rejects a non-numeric param with 422", async () => {
    expect((await client.get("/validate-params/abc")).status).toBe(422);
  });

  it("validates and coerces a valid body", async () => {
    const res = await client.post("/validate-body", JSON.stringify({ name: "ignus", age: "7" }), {
      headers: json,
    });
    expect(await jsonBody(res)).toEqual({ body: { name: "ignus", age: 7 } });
  });

  it("rejects a missing required body field with 422", async () => {
    const res = await client.post("/validate-body", JSON.stringify({ age: 1 }), {
      headers: json,
    });
    expect(res.status).toBe(422);
  });

  it("rejects malformed JSON before validation with 400", async () => {
    const res = await client.post("/validate-body", "{bad-json", { headers: json });
    expect(res.status).toBe(400);
  });

  it("validates required request headers", async () => {
    expect((await client.get("/validate-headers", { headers: { "x-token": "abc" } })).status).toBe(
      200,
    );
    expect((await client.get("/validate-headers")).status).toBe(422);
  });

  it("serializes the 200 response schema", async () => {
    const res = await client.get("/serialize");
    expect(await jsonBody(res)).toEqual({ name: "ignus", level: 1 });
  });

  it("serializes the 201 response schema by status", async () => {
    const res = await client.get("/serialize?code=201");
    expect(res.status).toBe(201);
    expect(await jsonBody(res)).toEqual({ created: true });
  });
});
