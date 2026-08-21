/**
 * Tests for the route→module split (`ignex route` with --module, the default):
 * business logic lands in src/modules/<route>.ts and the route file stays a
 * thin HTTP layer calling the module's handle().
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runRoute } from "../src/commands/route.js";
import {
  moduleFileTemplate,
  moduleImportFor,
  modulePathFor,
  routeWithModuleTemplate,
} from "../src/templates/module.js";
import { parseRouteInput } from "../src/utils/route.js";

describe("modulePathFor", () => {
  it("mirrors the route file under src/modules", () => {
    expect(modulePathFor(parseRouteInput("hello.get"))).toBe("modules/hello.get.ts");
    expect(modulePathFor(parseRouteInput("products/[id].get"))).toBe(
      "modules/products/[id].get.ts",
    );
    expect(modulePathFor(parseRouteInput("api/users/list.post"))).toBe(
      "modules/api/users/list.post.ts",
    );
  });
});

describe("moduleImportFor", () => {
  it("computes the ../ prefix per directory depth", () => {
    expect(moduleImportFor(parseRouteInput("hello.get"))).toBe("../modules/hello.get.js");
    expect(moduleImportFor(parseRouteInput("products/[id].get"))).toBe(
      "../../modules/products/[id].get.js",
    );
    expect(moduleImportFor(parseRouteInput("api/users/list.post"))).toBe(
      "../../../modules/api/users/list.post.js",
    );
  });
});

describe("moduleFileTemplate", () => {
  it("scaffolds a handle() for a plain GET", () => {
    const code = moduleFileTemplate(parseRouteInput("hello.get"));
    expect(code).toContain("Business logic for GET /hello.");
    expect(code).toContain("export async function handle(ctx: ModuleContext)");
    expect(code).toContain("return { ok: true };");
  });

  it("wires path params for dynamic routes", () => {
    const code = moduleFileTemplate(parseRouteInput("products/[id].get"));
    expect(code).toContain("const { id } = ctx.params;");
    expect(code).toContain("return { received: { id }, ok: true };");
  });

  it("parses the body for POST/PUT/PATCH", () => {
    const code = moduleFileTemplate(parseRouteInput("products/add", "post"));
    expect(code).toContain("const body = await ctx.body.json();");
    expect(code).toContain("return { received: body, ok: true };");
  });

  it("returns deleted for DELETE", () => {
    const code = moduleFileTemplate(parseRouteInput("products/[id].del"));
    expect(code).toContain("return { deleted: true };");
  });
});

describe("routeWithModuleTemplate", () => {
  it("emits a thin default route delegating to handle()", () => {
    const code = routeWithModuleTemplate(parseRouteInput("hello.get"));
    expect(code).toContain('import { get } from "@ignex/core/http";');
    expect(code).toContain('import { handle } from "../modules/hello.get.js";');
    expect(code).toContain("export default get(async (ctx) => {");
    expect(code).toContain("return ctx.json(await handle(ctx));");
  });

  it("adds a 201 status for POST", () => {
    const code = routeWithModuleTemplate(parseRouteInput("orders", "post"));
    expect(code).toContain("return ctx.json(await handle(ctx), { status: 201 });");
  });

  it("supports named exports", () => {
    const code = routeWithModuleTemplate(parseRouteInput("hello.get"), { named: true });
    expect(code).toContain("export const httpGet = get(async (ctx) => {");
  });

  it("keeps the schema export in the HTTP layer", () => {
    const code = routeWithModuleTemplate(parseRouteInput("products/[id].get"), {
      schema: true,
    });
    expect(code).toContain('import { Type } from "typebox";');
    expect(code).toContain("export const schema = {");
    expect(code).toContain("params: Type.Object({ id: Type.String() }),");
  });
});

describe("ignex route (module wiring)", () => {
  /** Create a throwaway project dir for one test. */
  function tmpTarget(): string {
    return mkdtempSync(join(tmpdir(), "ignex-cli-route-module-"));
  }

  it("scaffolds the module + a thin route by default", async () => {
    const dir = tmpTarget();
    try {
      await runRoute(["products/[id].get", "--root", dir]);

      const routeFile = join(dir, "src/routes/products/[id].get.ts");
      const moduleFile = join(dir, "src/modules/products/[id].get.ts");
      expect(existsSync(routeFile)).toBe(true);
      expect(existsSync(moduleFile)).toBe(true);
      expect(readFileSync(routeFile, "utf8")).toContain(
        'import { handle } from "../../modules/products/[id].get.js";',
      );
      expect(readFileSync(moduleFile, "utf8")).toContain("const { id } = ctx.params;");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects --no-module for the classic single-file route", async () => {
    const dir = tmpTarget();
    try {
      await runRoute(["health", "--no-module", "--root", dir]);

      expect(existsSync(join(dir, "src/routes/health.get.ts"))).toBe(true);
      expect(existsSync(join(dir, "src/modules/health.get.ts"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
