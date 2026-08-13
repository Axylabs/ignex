/**
 * Generated-client TYPE contract + drift guard.
 *
 * `test/fixtures/client-types/` holds a committed snapshot of what the
 * generators emit for a two-route app (`GET /`, `GET /products/:id`). This
 * suite:
 * 1. type-checks the snapshot with `expectTypeOf` — a params route must type
 *    as `(params, init?)` and a param-less route as `(init?)`; and
 * 2. guards against drift — the generators' current output must equal the
 *    committed snapshot, so any intentional codegen change updates the
 *    snapshot deliberately (and bumps COMPILER_CACHE_VERSION).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectTypeOf } from "expect-type";
import { describe, expect, it } from "vitest";
import type { RouteIR } from "../src";
import { generateClient, generateClientDts, generateRouteTypes } from "../src";
import { createApiClient } from "./fixtures/client-types/client.js";

const snapshot = (name: string): string =>
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "fixtures", "client-types", name),
    "utf8",
  );

// The routes the snapshot was generated from (covers all four call shapes).
const makeRoute = (method: string, path: string, paramNames: string[], body = false): RouteIR =>
  ({
    source: { method, path, paramNames },
    analysis: { usage: body ? { body: true } : {} },
  }) as unknown as RouteIR;

const snapshotRoutes = [
  makeRoute("GET", "/", []),
  makeRoute("GET", "/products/:id", ["id"]),
  makeRoute("POST", "/echo", [], true),
  makeRoute("POST", "/submit/:id", ["id"], true),
];

describe("generated client type contract", () => {
  it("types each route call shape from its declared params/body", () => {
    const client = createApiClient("http://api.test");

    // Params-only → `(params: { id: string }, init?)`.
    expectTypeOf(client["/products/:id"].get).parameters.toEqualTypeOf<
      [params: { id: string }, init?: RequestInit]
    >();

    // No params/body → `(init?)`.
    expectTypeOf(client["/"].get).parameters.toEqualTypeOf<[init?: RequestInit]>();

    // Body-only → `(body, init?)`.
    expectTypeOf(client["/echo"].post).parameters.toEqualTypeOf<
      [body: unknown, init?: RequestInit]
    >();

    // Params + body → `(params, body, init?)`.
    expectTypeOf(client["/submit/:id"].post).parameters.toEqualTypeOf<
      [params: { id: string }, body: unknown, init?: RequestInit]
    >();

    // Every call returns a Promise.
    expectTypeOf(client["/"].get).returns.toBeFunction();
  });

  it("keeps the committed snapshot in sync with the generators (drift guard)", () => {
    expect(generateClient(snapshotRoutes)).toBe(snapshot("client.ts"));
    expect(generateRouteTypes(snapshotRoutes)).toBe(snapshot("routes.d.ts"));
    expect(generateClientDts()).toBe(snapshot("client.d.ts"));
  });
});
