/**
 * SDK client generation tests — content, runtime behavior, and structure of
 * the generated `client.ts` / `client.d.ts` / `routes.d.ts` artifacts that
 * `ignus build` surfaces as the app SDK.
 *
 * Covers:
 * - content: ROUTES map, PARAM_PATHS, buildUrl encoding, codegen-time
 *   params-vs-init dispatch (no runtime guessing), init merge
 * - runtime: the generated `createApiClient` executed against a mocked
 *   `fetch` (no server) — header preservation, param encoding, ROUTES-key
 *   fallback, non-2xx throw
 * - type contract: see `client-types.test.ts` (expectTypeOf on IgnusClient).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src";
import { materializeFixture } from "./helpers";

/** Build the `basic` fixture plus dynamic `products/[id]` and body routes. */
const buildWithParamRoute = async (): Promise<{ outDir: string }> => {
  const { routesDir, outDir } = materializeFixture("basic");
  mkdirSync(join(routesDir, "products"), { recursive: true });
  writeFileSync(
    join(routesDir, "products", "[id].get.ts"),
    'export default () => ({ id: "x" });\n',
  );
  writeFileSync(join(routesDir, "notify.post.ts"), "export default (ctx) => ctx.body.json();\n");
  const result = await buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
  });
  expect(result.errors).toHaveLength(0);
  return { outDir };
};

describe("generated client.ts (SDK)", () => {
  it("emits ROUTES entries and a type-aware params dispatch", async () => {
    const { outDir } = await buildWithParamRoute();
    const client = readFileSync(join(outDir, "client.ts"), "utf8");

    // Imports + mapped type contract.
    expect(client).toContain('import { createClient } from "@ignus/core"');
    expect(client).toContain("export type IgnusClient");
    expect(client).toContain("type IgnusRouteHandler<Route>");

    // ROUTES map keys for every non-ALL route.
    expect(client).toContain('"get /health"');
    expect(client).toContain('"post /echo"');
    expect(client).toContain('"get /products/:id"');

    // Codegen-time knowledge drives params-vs-init (no runtime heuristic) and
    // the params+body call shape is part of the emitted contract.
    expect(client).toContain(
      'const ROUTE_ARGS: Record<string, "none" | "params" | "body" | "params+body"> = {',
    );
    expect(client).toContain('"/products/:id": "params"');
    expect(client).toContain('"params+body"');
    expect(client).not.toContain("instanceof URLSearchParams");

    // buildUrl encodes `:key` / `*key` and init is deep-merged.
    expect(client).toContain("encodeURIComponent(String(value))");
    expect(client).toContain("mergeInit");
  });

  it("emits client.d.ts and routes.d.ts with per-route param/query/body markers", async () => {
    const { outDir } = await buildWithParamRoute();

    const dts = readFileSync(join(outDir, "client.d.ts"), "utf8");
    expect(dts).toContain("export type IgnusClient");
    expect(dts).toContain("export declare function createApiClient");

    const routes = readFileSync(join(outDir, "routes.d.ts"), "utf8");
    expect(routes).toContain("export interface IgnusRoutes");
    // Param route declares a typed params object.
    expect(routes).toContain('"/products/:id": {');
    expect(routes).toContain("      params: {");
    expect(routes).toContain("    id: string;");
    // Param-less route has no params property.
    expect(routes).toContain('"/health": {\n    get: {\n      response: unknown;');
  });
});

describe("generated client.ts (runtime)", () => {
  it("requests correctly: headers, param encoding, ROUTES fallback, init merge", async () => {
    const { outDir } = await buildWithParamRoute();

    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const mockFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ url, init });
      return new Response(JSON.stringify({ ok: true, url }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch;

    try {
      const mod = (await import(pathToFileURL(join(outDir, "client.ts")).href)) as {
        createApiClient: (
          baseUrl?: string,
          init?: RequestInit,
        ) => {
          [k: string]: { [m: string]: (...args: unknown[]) => Promise<unknown> };
        };
      };
      const client = mod.createApiClient("http://api.test");

      // 1. Param-less route: a plain-object init (headers) must be preserved,
      //    not misread as `params` (regression guard for the old heuristic).
      //    Access order is path-then-method, matching the IgnusClient type.
      await client["/health"].get({ headers: { "x-auth": "t" } });
      expect(requests[0]?.url).toBe("http://api.test/health");
      expect((requests[0]?.init?.headers as Record<string, string>)?.["x-auth"]).toBe("t");

      // 2. ROUTES-key access ("get /about") resolves to the literal path.
      await client["get /about"].get();
      expect(requests[1]?.url).toBe("http://api.test/about");

      // 3. Param route: values are URL-encoded into `:key` segments.
      await client["/products/:id"].get({ id: "a b/c" });
      expect(requests[2]?.url).toBe("http://api.test/products/a%20b%2Fc");

      // 3b. Body route: the body is JSON-serialized and POSTed.
      await client["/notify"].post({ hello: "world" });
      const bodyInit = requests[3]?.init;
      expect(requests[3]?.url).toBe("http://api.test/notify");
      expect(bodyInit?.method).toBe("POST");
      expect(bodyInit?.body).toBe('{"hello":"world"}');

      // 4. Client-wide init headers deep-merge with per-call headers.
      const withBase = mod.createApiClient("http://api.test", {
        headers: { "x-app": "1" },
      });
      await withBase["/health"].get({ headers: { "x-call": "2" } });
      const lastHeaders = requests[4]?.init?.headers as Record<string, string>;
      expect(lastHeaders?.["x-app"]).toBe("1");
      expect(lastHeaders?.["x-call"]).toBe("2");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws a status-carrying Error on non-2xx", async () => {
    const { outDir } = await buildWithParamRoute();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("nope", { status: 404 })) as typeof fetch;

    try {
      const mod = (await import(pathToFileURL(join(outDir, "client.ts")).href)) as {
        createApiClient: (
          baseUrl?: string,
          init?: RequestInit,
        ) => {
          [k: string]: { [m: string]: (...args: unknown[]) => Promise<unknown> };
        };
      };
      await expect(mod.createApiClient("http://api.test")["/health"].get()).rejects.toMatchObject({
        status: 404,
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
