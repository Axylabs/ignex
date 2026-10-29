/**
 * Named-export route hooks + query contract regressions.
 *
 * A route file may export its handler as `export const httpGet = get(...)`.
 * That form must behave EXACTLY like the default-export form:
 *   - runtime `before`/`after` chains (non-static guards such as
 *     `requireAuth()`) are wired from `handler.config`,
 *   - such routes are never inlined (inlining drops `handler.config`),
 *   - `ctx.query` without a query schema keeps the URLSearchParams contract
 *     in compiled builds instead of becoming a grouped Record.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src";
import { type FixtureLayout, materializeFixture } from "./helpers";

const options = (layout: FixtureLayout, extra: Record<string, unknown> = {}) => ({
  routesDir: layout.routesDir,
  outDir: layout.outDir,
  outFile: "server.js",
  minify: false,
  sourceMap: false,
  incremental: false,
  generateTypes: false,
  generateOpenAPI: false,
  generateClient: false,
  precompileValidators: true,
  precompileSerializers: true,
  ...extra,
});

describe("named-export route local hooks", () => {
  it("wires a runtime before chain from handler.config", async () => {
    const result = await buildAsync(options(materializeFixture("named-export-hooks")));

    expect(result.errors).toHaveLength(0);
    expect(result.code).toMatch(/handler__h\d+\?\.config\?\.before/);
  });

  it("wires a runtime after chain from handler.config", async () => {
    const result = await buildAsync(options(materializeFixture("named-export-hooks")));

    expect(result.errors).toHaveLength(0);
    expect(result.code).toMatch(/handler__h\d+\?\.config\?\.after/);
  });

  it("keeps ctx.query as URLSearchParams when no query schema exists", async () => {
    const result = await buildAsync(options(materializeFixture("named-export-hooks")));

    expect(result.errors).toHaveLength(0);
    // The full-context prelude must not shadow the lazy URLSearchParams
    // getter with a grouped Record (that made `.get()` throw in AOT builds).
    expect(result.code).not.toContain("ctx.query = __query");
    expect(result.code).not.toContain("groupQueryPairs");
  });

  it("resolves the runtime schema from a named handler export", async () => {
    // `httpGet.schema` (not `default.schema`) carries the route schema for a
    // named export; without this lookup runtime validation was skipped.
    const result = await buildAsync(
      options(materializeFixture("named-export-hooks"), {
        precompileValidators: false,
        precompileSerializers: false,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.code).toMatch(/__schemaFor\(schema__h\d+, "httpGet"\)/);
  });

  it("records the hook wiring in the build manifest (route:list diagnostics)", async () => {
    const layout = materializeFixture("named-export-hooks");
    const result = await buildAsync(options(layout));

    expect(result.errors).toHaveLength(0);
    const manifest = JSON.parse(readFileSync(join(layout.outDir, "manifest.json"), "utf8")) as {
      routes: Array<{
        path: string;
        localHooks?: boolean;
        shouldInline?: boolean;
        schemaParts?: string[];
      }>;
    };
    const me = manifest.routes.find((r) => r.path === "/me");
    expect(me?.localHooks).toBe(true);
    expect(me?.shouldInline).toBe(false);
    const query = manifest.routes.find((r) => r.path === "/query");
    expect(query?.schemaParts).toContain("response");
    expect(query?.schemaParts).not.toContain("query");
  });

  it("never inlines a route with a runtime hook chain", async () => {
    const result = await buildAsync(options(materializeFixture("local-hooks-inline")));

    expect(result.errors).toHaveLength(0);
    expect(result.code).not.toContain("Inlined route handler");
    expect(result.code).toMatch(/handler__h\d+\?\.config\?\.before/);
  });
});
