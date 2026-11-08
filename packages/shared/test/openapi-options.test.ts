/**
 * @fileoverview Shared OpenAPI customization and exclusion contract.
 */

import { describe, expect, it } from "vitest";
import { generateOpenAPI, type RouteDefinition } from "../src/openapi";

const info = { title: "Test API", version: "1.0.0" };
const routes: RouteDefinition[] = [
  { method: "GET", path: "/health" },
  { method: "POST", path: "/health" },
  { method: "GET", path: "/users/:id" },
  { method: "GET", path: "/assets/app.js" },
];

describe("OpenAPI document options", () => {
  it("applies servers, security, and an explicit tag list", () => {
    const spec = generateOpenAPI(info, routes, {
      servers: [{ url: "https://api.example.com" }],
      security: [{ bearer: [] }],
      tags: [],
    });
    expect(spec.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(spec.security).toEqual([{ bearer: [] }]);
    expect(spec.tags).toEqual([]);
  });

  it("excludes methods, route/OpenAPI paths, and static-looking files", () => {
    const spec = generateOpenAPI(info, routes, {
      exclude: {
        methods: ["post"],
        paths: ["/users/{id}"],
        staticFile: true,
      },
    });
    expect(spec.paths).toEqual({ "/health": { get: expect.any(Object) } });
  });

  it("supports stateful regular expressions without cross-route drift", () => {
    const spec = generateOpenAPI(info, routes, {
      exclude: { paths: [/health/g, /users/g] },
    });
    expect(spec.paths).toHaveProperty("/assets/app.js");
    expect(spec.paths).not.toHaveProperty("/health");
    expect(spec.paths).not.toHaveProperty("/users/{id}");
  });

  it("runs a final pure transform and rejects invalid results", () => {
    const spec = generateOpenAPI(info, routes, {
      transform: (document) => ({
        ...document,
        "x-lifecycle": "generated",
      }),
    });
    expect(spec["x-lifecycle"]).toBe("generated");
    expect(() => generateOpenAPI(info, routes, { transform: () => null as never })).toThrow(
      /must return a document object/,
    );
  });
});
