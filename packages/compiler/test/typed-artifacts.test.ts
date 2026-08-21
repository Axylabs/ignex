/**
 * Typed-artifact regression test (2026-08-19).
 *
 * `routes.d.ts` must emit REAL body types for route modules that export a
 * TypeBox `schema` const (`Static<typeof schema.body>`), instead of the old
 * `body: unknown` stub. The generated client derives its call signature from
 * these types, so this is what makes the "typed client" actually typed.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

describe("typed artifacts (routes.d.ts from TypeBox schema)", () => {
  it("emits Static<typeof schema.body> for a route with a schema const", async () => {
    const layout = materializeFixture("typed");
    const result = await buildAsync({
      routesDir: layout.routesDir,
      outDir: layout.outDir,
      outFile: "server.js",
      generateTypes: true,
      generateOpenAPI: true,
      generateClient: true,
    });

    expect(result.errors).toHaveLength(0);

    const types = readFileSync(join(layout.outDir, "routes.d.ts"), "utf8");
    expect(types).toContain('import type { Static } from "typebox";');
    expect(types).toMatch(/import type \{ schema as schema_\w+ \} from "\.\/routes\/order\.post"/);
    expect(types).toMatch(/body: Static<typeof schema_\w+\.body>;/);

    // The generated client references the real body type (not `unknown`).
    const client = readFileSync(join(layout.outDir, "client.d.ts"), "utf8");
    expect(client).toContain("IgnexRoutes");
  });
});
