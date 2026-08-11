import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProject, findServerEntry } from "../src/utils/compiler.js";

describe("buildProject (integration with @flux/compiler)", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "flux-cli-build-"));
    mkdirSync(join(dir, "src/routes"), { recursive: true });
    writeFileSync(join(dir, "src/routes", "index.get.ts"), 'export default () => "ok";\n');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("roots relative compiler paths against the project root", async () => {
    const { opts } = await buildProject(dir, {});
    expect(opts.routesDir).toBe(join(dir, "src/routes"));
    expect(opts.outDir).toBe(join(dir, ".flux"));
  });

  it("produces a runnable server entry in the rooted outDir", async () => {
    const { opts } = await buildProject(dir, {});
    const entry = await findServerEntry(dir, opts);
    expect(entry).toBe(join(dir, ".flux", "server.js"));
    expect(entry).toBeDefined();
    expect(existsSync(entry as string)).toBe(true);
  });
});
