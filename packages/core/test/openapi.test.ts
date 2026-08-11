import { describe, expect, it } from "vitest";
import { generateOpenAPI } from "../src/index.js";

const info = { title: "Test API", version: "1.0.0" };

describe("generateOpenAPI", () => {
  it("converts :params and *wildcards to {braces}", () => {
    const spec = generateOpenAPI(info, [
      { method: "GET", path: "/products/:id/reviews/:rid" },
      { method: "GET", path: "/files/*path" },
    ]);
    expect(spec.paths).toHaveProperty("/products/{id}/reviews/{rid}");
    expect(spec.paths).toHaveProperty("/files/{path}");
  });

  it("skips ALL and WS routes", () => {
    const spec = generateOpenAPI(info, [
      { method: "ALL", path: "/anything" },
      { method: "WS", path: "/socket" },
      { method: "GET", path: "/ok" },
    ]);
    expect(spec.paths).toHaveProperty("/ok");
    expect(spec.paths).not.toHaveProperty("/anything");
    expect(spec.paths).not.toHaveProperty("/socket");
  });

  it("emits path params with required flag and format", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "GET",
        path: "/users/:id",
        schema: {
          params: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", format: "uuid" } },
          },
        },
      },
    ]);
    const op = (spec.paths["/users/{id}"] as Record<string, any>).get;
    expect(op.parameters[0]).toMatchObject({
      name: "id",
      in: "path",
      required: true,
      schema: { type: "string", format: "uuid" },
    });
  });

  it("emits query params with defaults and merges into parameters", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "GET",
        path: "/search",
        schema: {
          query: {
            type: "object",
            required: ["q"],
            properties: {
              q: { type: "string" },
              page: { type: "integer", default: 1 },
            },
          },
        },
      },
    ]);
    const op = (spec.paths["/search"] as Record<string, any>).get;
    expect(op.parameters).toHaveLength(2);
    expect(op.parameters[0]).toMatchObject({ name: "q", in: "query", required: true });
    expect(op.parameters[1]).toMatchObject({
      name: "page",
      in: "query",
      required: false,
      schema: { type: "integer", default: 1 },
    });
  });

  it("includes requestBody for body schemas and a default 200 response", () => {
    const spec = generateOpenAPI(info, [
      { method: "POST", path: "/echo", schema: { body: { type: "object" } } },
    ]);
    const op = (spec.paths["/echo"] as Record<string, any>).post;
    expect(op.requestBody.content["application/json"].schema).toEqual({ type: "object" });
    expect(op.responses["200"]).toEqual({ description: "Successful response" });
  });

  it("spreads detail into the operation and builds operationId", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "DELETE",
        path: "/items/:id",
        detail: { summary: "Remove an item", tags: ["items"] },
      },
    ]);
    const op = (spec.paths["/items/{id}"] as Record<string, any>).delete;
    expect(op.summary).toBe("Remove an item");
    expect(op.tags).toEqual(["items"]);
    expect(op.operationId).toBe("delete__items__id_");
  });

  it("exposes openapi version and info", () => {
    const spec = generateOpenAPI(info, [{ method: "GET", path: "/" }]);
    expect(spec.openapi).toBe("3.1.0");
    expect(spec.info).toEqual(info);
  });

  it("emits header + cookie parameters and dedups by name:in", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "GET",
        path: "/items/:id",
        schema: {
          params: { type: "object", properties: { id: { type: "string" } } },
          query: { type: "object", properties: { id: { type: "integer" } } },
          headers: {
            type: "object",
            required: ["x-token"],
            properties: { "x-token": { type: "string" }, "x-trace": { type: "string" } },
          },
          cookie: { type: "object", properties: { session: { type: "string" } } },
        },
      },
    ]);
    const op = (spec.paths["/items/{id}"] as Record<string, any>).get;
    // path `id` and query `id` are distinct (different `in`), both kept.
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
      { name: "id", in: "query", required: false, schema: { type: "integer" } },
      { name: "x-token", in: "header", required: true, schema: { type: "string" } },
      { name: "x-trace", in: "header", required: false, schema: { type: "string" } },
      { name: "session", in: "cookie", required: false, schema: { type: "string" } },
    ]);
  });

  it("emits per-status responses from a response status map", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "POST",
        path: "/items",
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
          response: {
            200: { type: "object", properties: { ok: { type: "boolean" } } },
            422: { type: "object", properties: { error: { type: "string" } } },
          },
        },
      },
    ]);
    const op = (spec.paths["/items"] as Record<string, any>).post;
    expect(op.requestBody).toMatchObject({ required: true });
    expect(op.responses["200"].description).toBe("OK");
    expect(op.responses["422"].description).toBe("Unprocessable Entity");
    expect(op.responses["422"].content["application/json"].schema).toEqual({
      type: "object",
      properties: { error: { type: "string" } },
    });
  });

  it("hoists $defs into components.schemas and rewrites $ref", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "GET",
        path: "/widgets/:id",
        schema: {
          response: {
            type: "object",
            $defs: { Widget: { type: "object", properties: { id: { type: "string" } } } },
            properties: { widget: { $ref: "#/$defs/Widget" } },
          },
        },
      },
    ]);
    const op = (spec.paths["/widgets/{id}"] as Record<string, any>).get;
    expect(op.responses["200"].content["application/json"].schema.properties.widget).toEqual({
      $ref: "#/components/schemas/Widget",
    });
    expect(spec.components.schemas.Widget).toEqual({
      type: "object",
      properties: { id: { type: "string" } },
    });
  });

  it("falls back to string path params and object body from hints", () => {
    const spec = generateOpenAPI(info, [
      { method: "POST", path: "/submit/:id", paramNames: ["id"], usesBody: true },
    ]);
    const op = (spec.paths["/submit/{id}"] as Record<string, any>).post;
    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(op.requestBody).toEqual({
      required: false,
      content: { "application/json": { schema: { type: "object" } } },
    });
  });

  it("strips $id from emitted schemas", () => {
    const spec = generateOpenAPI(info, [
      {
        method: "POST",
        path: "/echo",
        schema: {
          body: { $id: "EchoBody", type: "object", properties: { a: { type: "string" } } },
        },
      },
    ]);
    const op = (spec.paths["/echo"] as Record<string, any>).post;
    expect(op.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { a: { type: "string" } },
    });
  });
});
