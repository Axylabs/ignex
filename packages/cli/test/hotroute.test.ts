/**
 * Tests for `ignex hotroute` — the hot-cache resource templates (pure
 * functions) plus the `runHotRoute` command wiring (module + route layout).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { runHotRoute } from "../src/commands/hotroute.js";
import { findCommand } from "../src/commands/registry.js";
import {
  hotCacheTemplate,
  hotDelTemplate,
  hotGetTemplate,
  hotListTemplate,
  hotModuleTemplates,
  hotPatchTemplate,
  hotPostTemplate,
  hotResourceReadmeTemplate,
  hotRouteTemplates,
} from "../src/templates/hotroute.js";
import { parseFlagDocs } from "../src/utils/completion.js";

test("hotCacheTemplate wires a shared HotCache over the collection", () => {
  const code = hotCacheTemplate("Gig");
  expect(code).toContain('import { createHotCache } from "@ignex/ninox";');
  expect(code).toContain("export const gigsCache = createHotCache();");
  expect(code).toContain('export const gigs = gigsCache.register("gigs", {');
  expect(code).toContain('loader: (_id: ObjectId) => db.getOne("gigs", { _id })');
  expect(code).toContain('watch: [{ collection: "gigs", db: db.client }]');
  expect(code).toContain("gigsCache.start();");
});

test("module templates export plain per-op functions (no handlers in modules)", () => {
  expect(hotGetTemplate("Gig")).toContain(
    "export const getGig = (id: ObjectId): Promise<Gig | null> => gigs.get(id);",
  );
  expect(hotListTemplate("Gig")).toContain(
    'db.paginateFlexible("gigs", {}, { page, limit, sort: { createdAt: -1 } })',
  );
  expect(hotPostTemplate("Gig")).toContain("export const createGig = (input: InsertInput<Gig>)");
  expect(hotPatchTemplate("Gig")).toContain("export const updateGig = (id: ObjectId,");
  expect(hotDelTemplate("Gig")).toContain("export const deleteGig = (id: ObjectId)");
});

test("hotModuleTemplates lays out src/modules/<plural>/ per-op files", () => {
  const files = hotModuleTemplates("Gig");
  const paths = files.map((f) => f.path);
  expect(paths).toEqual([
    "modules/gigs/gigs.cache.ts",
    "modules/gigs/get.ts",
    "modules/gigs/list.ts",
    "modules/gigs/post.ts",
    "modules/gigs/patch.ts",
    "modules/gigs/del.ts",
  ]);
});

test("hotRouteTemplates generates thin routes wired to the modules", () => {
  const files = hotRouteTemplates("Gig");
  const paths = files.map((f) => f.path);
  expect(paths).toEqual([
    "api/gigs/[id].get.ts",
    "api/gigs/[id].patch.ts",
    "api/gigs/[id].del.ts",
    "api/gigs/index.get.ts",
    "api/gigs/index.post.ts",
  ]);

  const getOne = files.find((f) => f.path === "api/gigs/[id].get.ts")?.content ?? "";
  expect(getOne).toContain('import { getGig } from "../../../modules/gigs/get.js";');
  expect(getOne).toContain("export default get(async (ctx) => {");
  expect(getOne).toContain("await getGig(_id)");
  expect(getOne).toContain("throw new NotFoundError()");
  expect(getOne).not.toContain("createHotCache");

  const create = files.find((f) => f.path === "api/gigs/index.post.ts")?.content ?? "";
  expect(create).toContain('import { createGig } from "../../../modules/gigs/post.js";');
  expect(create).toContain("type GigInput = InsertInput<Gig>;");
});

test("hotResourceReadmeTemplate documents the module layout", () => {
  const readme = hotResourceReadmeTemplate("Gig");
  expect(readme).toContain("src/modules/gigs/");
  expect(readme).toContain("gigs.cache.ts");
  expect(readme).toContain("thin HTTP layers");
});

describe("runHotRoute target layout", () => {
  let dir: string;
  let cwd: string;

  beforeAll(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "ignex-cli-hotroute-"));
    process.chdir(dir);
  });

  afterAll(() => {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("scaffolds model + modules + thin routes + db.ts", async () => {
    await runHotRoute(["gig"]);

    // Model + db bootstrap.
    expect(existsSync(join(dir, "src", "models", "gigs.ts"))).toBe(true);
    expect(existsSync(join(dir, "src", "db.ts"))).toBe(true);

    // Module logic under src/modules/<plural>/.
    for (const file of ["gigs.cache.ts", "get.ts", "list.ts", "post.ts", "patch.ts", "del.ts"]) {
      expect(existsSync(join(dir, "src", "modules", "gigs", file))).toBe(true);
    }

    // Thin routes under src/routes/api/<plural>/.
    for (const file of [
      "[id].get.ts",
      "[id].patch.ts",
      "[id].del.ts",
      "index.get.ts",
      "index.post.ts",
    ]) {
      expect(existsSync(join(dir, "src", "routes", "api", "gigs", file))).toBe(true);
    }

    // The get-one route wires to the module, not inline HotCache.
    const getOne = readFileSync(join(dir, "src", "routes", "api", "gigs", "[id].get.ts"), "utf8");
    expect(getOne).toContain('import { getGig } from "../../../modules/gigs/get.js";');
    expect(getOne).not.toContain("createHotCache");
  });

  test("registers dbPlugin() + deps when an app.config/package.json exists", async () => {
    writeFileSync(
      join(dir, "src", "app.config.ts"),
      'import { openapi } from "@ignex/core";\n\nexport const plugins = [\n  openapi()\n];\n',
    );
    writeFileSync(
      join(dir, "package.json"),
      '{\n  "name": "app",\n  "private": true,\n  "type": "module",\n  "dependencies": { "@ignex/core": "latest" }\n}\n',
    );

    await runHotRoute(["event"]);

    const config = readFileSync(join(dir, "src", "app.config.ts"), "utf8");
    expect(config).toContain('import { dbPlugin } from "./db.js";');
    expect(config).toContain("  dbPlugin(),");

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(pkg.dependencies["@ignex/ninox"]).toBe("latest");
    expect(pkg.dependencies.typebox).toBe("latest");

    // The existing db.ts (created by the first resource) gets `events` merged in.
    const dbSrc = readFileSync(join(dir, "src", "db.ts"), "utf8");
    expect(dbSrc).toContain('import { events } from "./models/events.js";');
    expect(dbSrc).toContain("defineCollections(gigs, events)");
    expect(dbSrc).toContain('await db.createSchema("events");');
  });

  test("exposes the hotroute command with its flags", () => {
    const cmd = findCommand("hotroute");
    expect(cmd).toBeDefined();
    const flags = parseFlagDocs(cmd?.options);
    expect(flags.some((f) => f.flag === "--fields")).toBe(true);
  });
});
