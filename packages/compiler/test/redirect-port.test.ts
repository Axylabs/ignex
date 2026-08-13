/**
 * @fileoverview Port of Elysia AOT redirect behavior — the compiler-emitted
 * `redirectReply` must build a relative-safe redirect.
 *
 * Regression pin for the `redirectReply` fix: the emitted helper previously
 * used `Response.redirect(url, status)`, which throws on relative `Location`
 * values (e.g. undici under vitest and Bun for relative paths) — turning a
 * `ctx.redirect("/login")` in a compiled route into a 500. The fixed helper
 * sets the `Location` header directly, matching `ctx.redirect()`.
 */
import { describe, expect, it } from "vitest";
import { buildAsync } from "../src/index";
import { materializeFixture } from "./helpers";

describe("compile (redirect route)", () => {
  it("emits a relative-safe redirectReply (manual Location, not Response.redirect)", async () => {
    const layout = materializeFixture("redirect");
    const result = await buildAsync({
      routesDir: layout.routesDir,
      outDir: layout.outDir,
      outFile: "server.js",
      generateTypes: false,
      generateOpenAPI: false,
      generateClient: false,
    });

    expect(result.errors).toHaveLength(0);

    // The fixed helper sets Location directly instead of Response.redirect().
    expect(result.code).toContain("location: String(url)");
    expect(result.code).toContain("status, headers: { location");
    // The buggy helper must be gone from the emitted runtime.
    expect(result.code).not.toMatch(/Response\.redirect\(/);

    // The route wires the redirect reply helper.
    expect(result.code).toContain("redirect: redirectReply");
  });
});
