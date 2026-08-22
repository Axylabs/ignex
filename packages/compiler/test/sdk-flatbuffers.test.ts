/**
 * FlatBuffers SDK platform tests — schema/codec/client generation from the
 * compiled artifacts, plus a real round-trip through the generated codec on
 * the official `flatbuffers` runtime.
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { generateSdk, sdkPlatforms, writeSdk } from "../src/index.js";

/** Minimal compiled-artifact fixture (manifest.json + openapi.json). */
const FIXTURE_ARTIFACTS = {
  "manifest.json": JSON.stringify({
    serviceName: "petshop",
    routes: [
      { method: "GET", path: "/pets/:id", paramNames: ["id"], responseType: "json" },
      { method: "POST", path: "/pets", usage: { body: true }, responseType: "json" },
      { method: "GET", path: "/health", responseType: "json" },
    ],
  }),
  "openapi.json": JSON.stringify({
    openapi: "3.1.0",
    info: { title: "petshop", version: "1.0.0" },
    paths: {
      "/pets/{id}": {
        get: {
          parameters: [{ in: "path", name: "id", required: true, schema: { type: "string" } }],
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { id: { type: "string" }, name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
      "/pets": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { name: { type: "string" } },
                  required: ["name"],
                },
              },
            },
          },
          responses: {
            "201": {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { id: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/health": {
        get: {
          responses: { "200": { content: { "application/json": { schema: { type: "object" } } } } },
        },
      },
    },
  }),
};

/** Temp dir under the compiler package so the generated `import "flatbuffers"`
 * resolves up the tree to the workspace node_modules. */
const tmpDirs: string[] = [];
const tmpArtifacts = (): string => {
  const dir = mkdtempSync(join(process.cwd(), ".sdk-fb-test-"));
  tmpDirs.push(dir);
  // artifacts live next to the package dir (what writeSdk expects as outDir)
  writeFileSync(join(dir, "manifest.json"), FIXTURE_ARTIFACTS["manifest.json"]);
  writeFileSync(join(dir, "openapi.json"), FIXTURE_ARTIFACTS["openapi.json"]);
  return dir;
};

afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("flatbuffers platform", () => {
  it("is registered in the platform registry", () => {
    expect(sdkPlatforms.flatbuffers).toBeDefined();
    expect(sdkPlatforms.flatbuffers.id).toBe("flatbuffers");
  });

  it("generates the expected files from compiled artifacts", async () => {
    const root = tmpArtifacts();
    const result = await generateSdk({
      outDir: root,
      packageDir: join(root, "out"),
      name: "@acme/petshop-client",
      version: "1.2.3",
      platforms: ["flatbuffers"],
    });
    expect(result.packages).toHaveLength(1);
    const pkg = result.packages[0];
    if (pkg === undefined) throw new Error("no package");
    expect(pkg.platform).toBe("flatbuffers");
    const paths = pkg.files.map((f) => f.path);
    for (const expected of [
      "package.json",
      "README.md",
      "schema.fbs",
      "dist/codec.js",
      "dist/codec.d.ts",
      "dist/client.js",
      "dist/client.d.ts",
      "dist/types.d.ts",
      "dist/routes.d.ts",
      "dist/index.js",
      "dist/index.d.ts",
    ]) {
      expect(paths).toContain(expected);
    }

    const schema = pkg.files.find((f) => f.path === "schema.fbs")?.content ?? "";
    expect(schema).toContain("table Request");
    expect(schema).toContain("table Response");
    expect(schema).toContain("table RouteMeta");
    expect(schema).toContain("root_type Response");

    const pkgJson = JSON.parse(
      pkg.files.find((f) => f.path === "package.json")?.content ?? "{}",
    ) as {
      name: string;
      version: string;
      kind: string;
      platform: string;
      dependencies: Record<string, string>;
    };
    expect(pkgJson.name).toBe("@acme/petshop-client");
    expect(pkgJson.version).toBe("1.2.3");
    expect(pkgJson.kind).toBe("client");
    expect(pkgJson.platform).toBe("flatbuffers");
    expect(pkgJson.dependencies.flatbuffers).toMatch(/^\^25\./);

    // Typed routes carry the params/body/response types from the fixture.
    const types = pkg.files.find((f) => f.path === "dist/types.d.ts")?.content ?? "";
    expect(types).toContain("Params_GetPetsId");
    expect(types).toContain("Body_PostPets");
    expect(types).toContain("Response_PostPets");
  });

  it("writes a working codec that round-trips envelopes on the real runtime", async () => {
    const root = tmpArtifacts();
    const result = await writeSdk({
      outDir: root,
      packageDir: join(root, "out"),
      name: "@acme/petshop-client",
      version: "1.2.3",
      platforms: ["flatbuffers"],
    });
    const codecPath = join(result.packages[0]?.dir ?? "", "dist", "codec.js");
    expect(existsSync(codecPath)).toBe(true);

    const codec = (await import(codecPath)) as {
      encodeRequest(req: unknown): Uint8Array;
      decodeRequest(bytes: Uint8Array): unknown;
      encodeResponse(res: unknown): Uint8Array;
      decodeResponse(bytes: Uint8Array): unknown;
      encodeApiRoutes(routes: unknown[]): Uint8Array;
      decodeApiRoutes(bytes: Uint8Array): unknown[];
    };

    const req = {
      method: "POST",
      path: "/pets/:id",
      params: { id: "42" },
      query: { x: "1" },
      body: { name: "rex héllo ✓" },
    };
    const dec = codec.decodeRequest(codec.encodeRequest(req)) as typeof req;
    expect(dec).toEqual(req);

    const res = { status: 201, ok: true, error: "", bodyJson: '{"id":"p-1"}', traceId: "t-1" };
    expect(codec.decodeResponse(codec.encodeResponse(res))).toEqual(res);
    const err = { status: 404, ok: false, error: "not found", bodyJson: "", traceId: "" };
    expect(codec.decodeResponse(codec.encodeResponse(err))).toEqual(err);

    const routes = [
      { method: "GET", path: "/health", args: "none" },
      { method: "POST", path: "/pets", args: "body" },
    ];
    expect(codec.decodeApiRoutes(codec.encodeApiRoutes(routes))).toEqual(routes);
  });
});
