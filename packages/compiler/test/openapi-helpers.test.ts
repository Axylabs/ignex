/**
 * Tests for the standalone OpenAPI/SDK script contract.
 *
 * `scripts/generate-openapi-client.ts` delegates to the compiler — route
 * parsing via `parseRouteFilename` and OpenAPI shaping via `generateOpenApi`
 * over a minimal RouteDef shape it builds from loaded route modules. These
 * tests lock that public contract so the script and `ignus build` can never
 * drift apart again.
 */
import { describe, expect, it } from "vitest";
import type { CompilerOptions, RouteDef } from "../src";
import { generateOpenApi, parseRouteFilename } from "../src";

/** The minimal RouteDef shape the standalone script constructs. */
const scriptRoute = (
  method: string,
  path: string,
  paramNames: string[],
  schemaDoc: Record<string, unknown> | undefined,
  body = false,
): RouteDef =>
  ({
    source: { method, path, paramNames },
    analysis: { config: {}, usage: { body } },
    decisions: { schemaDoc },
  }) as unknown as RouteDef;

const opts = { serviceName: "ignus" } as CompilerOptions;

describe("parseRouteFilename (shared by CLI, compiler, script)", () => {
  it("decodes the file-based routing convention", () => {
    expect(parseRouteFilename("index.get.ts")).toMatchObject({
      method: "GET",
      path: "/",
      paramNames: [],
      isStatic: true,
    });
    expect(parseRouteFilename("users/[id].get.ts")).toMatchObject({
      method: "GET",
      path: "/users/:id",
      paramNames: ["id"],
      isDynamic: true,
    });
    expect(parseRouteFilename("files/[...rest].post.ts")).toMatchObject({
      method: "POST",
      path: "/files/*rest",
      paramNames: ["rest"],
      isDynamic: true,
    });
    // Method aliases + uppercase suffixes normalize the same way.
    expect(parseRouteFilename("admin/route.DEL.ts")).toMatchObject({
      method: "DELETE",
      path: "/admin/route",
    });
  });
});

describe("generateOpenApi over the script's RouteDef shape", () => {
  it("emits path params, requestBody, and responses from schemaDoc", () => {
    const route = scriptRoute(
      "POST",
      "/submit/:id",
      ["id"],
      {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
        },
        body: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
        response: {
          type: "object",
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
      },
      true,
    );

    const openapi = generateOpenApi([route], opts);
    const op = (openapi.paths as Record<string, Record<string, any>>)["/submit/{id}"].post;

    expect(op.parameters).toEqual([
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ]);
    expect(op.requestBody.content["application/json"].schema.properties.name).toEqual({
      type: "string",
    });
    expect(op.responses["200"].content["application/json"].schema.properties.ok).toEqual({
      type: "boolean",
    });
  });

  it("derives a default 200 response when no schema is attached", () => {
    const route = scriptRoute("GET", "/health", [], undefined);
    const openapi = generateOpenApi([route], opts);
    const op = (openapi.paths as Record<string, Record<string, any>>)["/health"].get;
    expect(op.responses["200"].description).toBe("Successful response");
  });
});
