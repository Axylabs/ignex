/**
 * @fileoverview Project-configured SDK generation and CLI precedence.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSdk } from "../src/commands/sdk";

let root: string;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "ignex-cli-sdk-config-"));
  await mkdir(join(root, "src/routes"), { recursive: true });
  writeFileSync(
    join(root, "src/routes/index.get.ts"),
    "export default (ctx) => ctx.json({ ok: true });\n",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "config-app", version: "1.0.0" }),
  );
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
  rmSync(root, { recursive: true, force: true });
});

const readPackage = (dir: string) =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;

describe("ignex sdk project config", () => {
  it("loads custom platforms and pure hooks from ignex.config.mjs", async () => {
    writeFileSync(
      join(root, "ignex.config.mjs"),
      `export default {
  sdk: {
    name: "@acme/from-config",
    version: "2.3.4",
    packageDir: "generated/sdk",
    platforms: [{
      id: "catalog",
      label: "Catalog",
      description: "Application-owned generator",
      generate(ctx) {
        return [{
          path: "package.json",
          content: JSON.stringify({ name: ctx.options.name, version: ctx.options.version })
        }];
      }
    }],
    hooks: {
      transformPackageJson(pkg) {
        return { ...pkg, license: "Apache-2.0", description: "Configured by the app" };
      },
      transformFiles(files) {
        return [...files, { path: "CUSTOM.md", content: "generated without patching" }];
      }
    }
  }
};
`,
    );

    await runSdk(["--root", root]);

    const dir = join(root, "generated/sdk");
    expect(process.exitCode).toBeUndefined();
    expect(readPackage(dir)).toMatchObject({
      name: "@acme/from-config",
      version: "2.3.4",
      license: "Apache-2.0",
      description: "Configured by the app",
    });
    expect(readFileSync(join(dir, "CUSTOM.md"), "utf8")).toBe("generated without patching");
  });

  it("lets CLI flags override configured TypeScript package options", async () => {
    writeFileSync(
      join(root, "ignex.config.mjs"),
      `export default {
  sdk: {
    name: "@acme/from-config",
    version: "2.3.4",
    packageDir: "generated/config-sdk",
    license: "Apache-2.0",
    description: "Configured description"
  }
};
`,
    );

    await runSdk([
      "--root",
      root,
      "--name",
      "@acme/from-cli",
      "--license",
      "MIT",
      "--out",
      "generated/cli-sdk",
    ]);

    const dir = join(root, "generated/cli-sdk");
    expect(process.exitCode).toBeUndefined();
    expect(existsSync(join(root, "generated/config-sdk"))).toBe(false);
    expect(readPackage(dir)).toMatchObject({
      name: "@acme/from-cli",
      version: "2.3.4",
      license: "MIT",
      description: "Configured description",
    });
  });
});
