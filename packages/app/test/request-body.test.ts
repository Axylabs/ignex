/**
 * @fileoverview Compiled-server request-body matrix.
 *
 * JSON (valid / malformed / empty / nested / oversized / charset variants),
 * form-urlencoded, multipart, text, raw/octet-stream, unknown content types,
 * and empty-body methods — the body-handling cases a backend framework must
 * get right (limits, error codes, dispatch by content type).
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

const json = (headers: Record<string, string> = {}) => ({
  headers: { "content-type": "application/json", ...headers },
});

describe("request-body matrix (compiled server)", () => {
  it("parses a JSON body", async () => {
    const res = await client.post("/body", JSON.stringify({ a: 1 }), json());
    expect(await jsonBody(res)).toEqual({ contentType: "application/json", value: { a: 1 } });
  });

  it("parses JSON with a charset parameter", async () => {
    const res = await client.post("/body", JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    });
    expect(await jsonBody(res)).toMatchObject({ value: { ok: true } });
  });

  it("parses an empty JSON object", async () => {
    const res = await client.post("/body", "{}", json());
    expect(await jsonBody(res)).toMatchObject({ value: {} });
  });

  it("parses a deeply nested JSON body", async () => {
    let nested: unknown = 0;
    for (let i = 0; i < 30; i++) nested = { level: i, child: nested };
    const res = await client.post("/body", JSON.stringify({ nested }), json());
    const body = (await jsonBody(res)) as { value: { nested: unknown } };
    expect(body.value).toHaveProperty("nested");
  });

  it("rejects malformed JSON with 400", async () => {
    const res = await client.post("/body", "{not-json", json());
    expect(res.status).toBe(400);
  });

  it("rejects JSON over the 2 MB limit with 413", async () => {
    const big = JSON.stringify({ data: "x".repeat(2 * 1024 * 1024) });
    const res = await client.post("/body", big, json());
    expect(res.status).toBe(413);
  });

  it("parses form-urlencoded bodies", async () => {
    const res = await client.post("/form", "a=1&b=two", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
    });
    expect(await jsonBody(res)).toEqual({ fields: { a: "1", b: "two" } });
  });

  it("parses text bodies", async () => {
    const res = await client.post("/text", "hello world", {
      headers: { "content-type": "text/plain" },
    });
    expect(await jsonBody(res)).toEqual({ text: "hello world" });
  });

  it("parses raw octet-stream bodies", async () => {
    const res = await client.post("/raw", "0123456789", {
      headers: { "content-type": "application/octet-stream" },
    });
    expect(await jsonBody(res)).toEqual({ bytes: 10, first: "01234567" });
  });

  it("treats an unknown content-type as raw bytes", async () => {
    const res = await client.post("/body", "abc", {
      headers: { "content-type": "application/x-custom" },
    });
    expect(await jsonBody(res)).toMatchObject({
      contentType: "application/x-custom",
      bytes: 3,
    });
  });

  it("uploads a multipart file with metadata", async () => {
    const form = new FormData();
    form.append("file", new Blob(["file-content-here"], { type: "text/plain" }), "notes.txt");
    const res = await client.post("/upload", form);
    expect(res.status).toBe(200);
    const body = (await jsonBody(res)) as { name?: string; size?: number; type?: string };
    expect(body.name).toBe("notes.txt");
    expect(body.size).toBe(17);
    expect(body.type).toContain("text/plain");
  });

  it("rejects a multipart request without a file (400)", async () => {
    const form = new FormData();
    form.append("note", "no file here");
    const res = await client.post("/upload", form);
    expect(res.status).toBe(400);
  });

  it("handles DELETE with no body on an ALL route", async () => {
    expect((await client.del("/echo")).status).toBe(200);
  });
});
