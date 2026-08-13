/**
 * Property-based tests for the OpenAPI generator: invariants that must hold
 * over generated route sets — unique operationIds, path/parameter agreement,
 * ALL/WS exclusion, and structural validity. Uses fast-check + shared
 * arbitraries from `@ignex/test-utils` for data variety.
 */

import { arbHttpMethod, arbJsonObject, arbRoutePath } from "@ignex/test-utils";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { HttpMethod, RouteDefinition } from "../src/index.js";
import { generateOpenAPI } from "../src/index.js";

const info = { title: "Prop API", version: "1.0.0" };

/** Extract every `:param` / `*wildcard` name from a route path. */
const paramNamesOf = (path: string): string[] =>
  [...path.matchAll(/[:*]([A-Za-z0-9_]+)/g)].map((m) => m[1]);

/** Convert `:param` / `*wildcard` to `{param}` (mirror of the generator). */
const toOpenApiPath = (path: string): string =>
  path.replace(/:([A-Za-z0-9_]+)/g, "{$1}").replace(/\*([A-Za-z0-9_]+)/g, "{$1}");

const asRoutes = (items: Array<{ method: string; path: string }>): RouteDefinition[] =>
  items.map((r) => ({ method: r.method as HttpMethod, path: r.path }));

const pathsOf = (spec: Record<string, unknown>): Record<string, Record<string, any>> =>
  spec.paths as Record<string, Record<string, any>>;

describe("generateOpenAPI (property)", () => {
  it("every emitted operation has a unique operationId across the document", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ method: arbHttpMethod, path: arbRoutePath }), { maxLength: 30 }),
        (entries) => {
          const spec = generateOpenAPI(info, asRoutes(entries));
          const ids = new Set<string>();
          for (const methods of Object.values(pathsOf(spec))) {
            for (const operation of Object.values(methods)) {
              expect(operation.operationId).toBeTypeOf("string");
              expect(ids.has(operation.operationId)).toBe(false);
              ids.add(operation.operationId);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("every emitted path placeholder has a required path parameter", () => {
    fc.assert(
      fc.property(fc.array(arbRoutePath, { maxLength: 20 }), (paths) => {
        const routes = paths.map((path) => ({
          method: "GET" as HttpMethod,
          path,
          paramNames: paramNamesOf(path),
        }));
        const spec = generateOpenAPI(info, routes);
        const doc = pathsOf(spec);
        for (const path of paths) {
          const operation = doc[toOpenApiPath(path)]?.get;
          expect(operation).toBeDefined();
          for (const match of toOpenApiPath(path).matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
            const param = (operation.parameters ?? []).find(
              (p: any) => p.in === "path" && p.name === match[1],
            );
            expect(param).toBeDefined();
            expect(param.required).toBe(true);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it("never emits ALL or WS routes into the document", () => {
    fc.assert(
      fc.property(fc.array(arbHttpMethod, { maxLength: 30 }), (methods) => {
        const spec = generateOpenAPI(
          info,
          asRoutes(methods.map((m) => ({ method: m, path: "/x" }))),
        );
        const emitted = new Set(
          Object.values(pathsOf(spec)).flatMap((methodsByPath) => Object.keys(methodsByPath)),
        );
        for (const method of emitted) {
          expect(["all", "ws"]).not.toContain(method);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("produces a structurally valid document for arbitrary route sets + JSON schemas", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            method: arbHttpMethod,
            path: arbRoutePath,
            schema: fc.option(arbJsonObject),
          }),
          { maxLength: 20 },
        ),
        (entries) => {
          const spec = generateOpenAPI(info, entries as unknown as RouteDefinition[]);
          expect(spec.openapi).toBe("3.1.0");
          expect(spec.info).toEqual(info);
          expect(spec.paths).toBeTypeOf("object");
          for (const methods of Object.values(pathsOf(spec))) {
            for (const operation of Object.values(methods)) {
              expect(operation.responses).toBeTypeOf("object");
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
