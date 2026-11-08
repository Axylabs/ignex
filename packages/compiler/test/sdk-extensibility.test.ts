/**
 * @fileoverview Consumer-extensible SDK platforms, hooks, and output safety.
 */

import { beforeAll, describe, expect, it } from "vitest";
import { buildAsync, generateSdk, type SdkPlatform, sdkPlatforms } from "../src";
import { materializeFixture } from "./helpers";

let outDir: string;

beforeAll(async () => {
  const fixture = materializeFixture("basic");
  outDir = fixture.outDir;
  const result = await buildAsync({
    routesDir: fixture.routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
  });
  expect(result.errors).toHaveLength(0);
});

const customPlatform = (files: Array<{ path: string; content: string }>): SdkPlatform => ({
  id: "custom",
  label: "Custom",
  description: "Test custom platform",
  generate: () => files,
});

describe("SDK extensibility", () => {
  it("accepts per-call platforms and applies async package/file hooks", async () => {
    const platform: SdkPlatform = {
      id: "catalog",
      label: "Catalog",
      description: "Custom catalog package",
      generate: async (ctx) => [
        {
          path: "package.json",
          content: JSON.stringify({ name: ctx.options.name, version: ctx.options.version }),
        },
        { path: "routes.json", content: JSON.stringify(ctx.routes) },
      ],
    };
    const result = await generateSdk({
      outDir,
      name: "@acme/custom",
      version: "2.0.0",
      platforms: [platform],
      hooks: {
        transformPackageJson: async (pkg, ctx) => ({
          ...pkg,
          keywords: [ctx.platform, ctx.serviceName],
          license: "Apache-2.0",
        }),
        transformFiles: async (files, ctx) => [
          ...files,
          { path: "README.md", content: `# ${ctx.platform}\n` },
        ],
      },
    });

    const files = new Map(result.packages[0]?.files.map((file) => [file.path, file.content]) ?? []);
    expect(JSON.parse(files.get("package.json") ?? "{}")).toMatchObject({
      name: "@acme/custom",
      version: "2.0.0",
      keywords: ["catalog", "ignex"],
      license: "Apache-2.0",
    });
    expect(files.get("README.md")).toBe("# catalog\n");
    expect(files.get("routes.json")).toContain("/");
    expect(sdkPlatforms.catalog).toBeUndefined();
  });

  it("keeps built-in generation unchanged when hooks are omitted", async () => {
    const result = await generateSdk({ outDir, platforms: ["typescript"] });
    expect(result.packages[0]?.files.map((file) => file.path)).toEqual([
      "package.json",
      "README.md",
      "openapi.json",
      "dist/types.d.ts",
      "dist/routes.d.ts",
      "dist/client.d.ts",
      "dist/client.js",
      "dist/index.d.ts",
      "dist/index.js",
    ]);
  });

  it("rejects duplicate and malformed custom platforms", async () => {
    await expect(generateSdk({ outDir, platforms: ["typescript", "typescript"] })).rejects.toThrow(
      /Duplicate SDK platform id/,
    );
    await expect(
      generateSdk({
        outDir,
        platforms: [{ ...customPlatform([]), id: "../escape" }],
      }),
    ).rejects.toThrow(/Custom SDK platforms require/);
    await expect(generateSdk({ outDir, platforms: [null as never] })).rejects.toThrow(
      /Custom SDK platforms require/,
    );
    await expect(
      generateSdk({
        outDir,
        platforms: [{ ...customPlatform([]), generate: () => null as never }],
      }),
    ).rejects.toThrow(/must return an array of files/);
  });

  it.each(["/absolute", "C:/absolute", "../escape", "nested//file", "nested\\file"])(
    "rejects unsafe generated path %s",
    async (path) => {
      await expect(
        generateSdk({
          outDir,
          platforms: [customPlatform([{ path, content: "no" }])],
        }),
      ).rejects.toThrow(/unsafe file path/);
    },
  );

  it("rejects duplicate files introduced by a hook", async () => {
    await expect(
      generateSdk({
        outDir,
        platforms: [customPlatform([{ path: "package.json", content: "{}" }])],
        hooks: {
          transformFiles: (files) => [...files, { path: "package.json", content: "{}" }],
        },
      }),
    ).rejects.toThrow(/duplicate file path/);
  });

  it("requires package transforms to return a plain object", async () => {
    await expect(
      generateSdk({
        outDir,
        platforms: [customPlatform([{ path: "package.json", content: "{}" }])],
        hooks: { transformPackageJson: () => null as never },
      }),
    ).rejects.toThrow(/must return a plain object/);
  });
});
