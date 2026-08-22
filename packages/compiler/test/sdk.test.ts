/**
 * SDK generation tests — the multi-platform SDK pipeline.
 *
 * Covers:
 * - JSON Schema → TS type emission (`jsonSchemaToTs`): primitives, objects,
 *   arrays, enums, unions, `allOf` merging, nullable, `$ref`, edge shapes.
 * - `generateSdk`/`writeSdk` against a compiled fixture: package layout,
 *   concrete body/params/query/response types, self-containment (no
 *   `@ignex/*` / app-source / typebox imports), determinism, multi-platform
 *   output (typescript + openapi spec).
 * - `packSdk` tarball output and `loadSdkInputs` error handling.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildAsync, generateSdk, loadSdkInputs, packSdk, resolveRepoUrl, writeSdk } from "../src";
import { jsonSchemaToTs } from "../src/sdk/json-schema-to-ts";
import { materializeFixture } from "./helpers";

/** Run a command synchronously in a directory, failing the test on error. */
const runSync = (cmd: string, args: string[], cwd: string): void => {
  const result = spawnSync(cmd, args, { cwd, stdio: "ignore" });
  expect(result.status).toBe(0);
};

/** Compile a fixture with schema-first routes (body/query/response types). */
const buildSchemaFixture = async (): Promise<string> => {
  const { routesDir, outDir } = materializeFixture("basic");

  // Body-schema route (TypeBox `schema` const, schema-first validation).
  writeFileSync(
    join(routesDir, "orders.post.ts"),
    `import { post } from "@ignex/core/http";
import { Type } from "typebox";

export const schema = {
  body: Type.Object({
    orderId: Type.String(),
    quantity: Type.Integer({ minimum: 1 }),
    totalCents: Type.Integer(),
  }),
};

export default post(async (ctx) => ctx.json({ ok: true }));
`,
  );

  // Params route with a typed response schema.
  mkdirSync(join(routesDir, "reports"), { recursive: true });
  writeFileSync(
    join(routesDir, "reports", "[id].get.ts"),
    `import { Type } from "typebox";

export const schema = {
  response: Type.Object({ id: Type.String(), rows: Type.Array(Type.String()) }),
};

export default async (ctx) => ctx.json({ id: ctx.params.id, rows: [] });
`,
  );

  // Same route template, different per-method call shapes (regression: the
  // SDK client's ROUTE_ARGS must key by "method path", not bare path, or the
  // DELETE (params) and PATCH (params+body) shapes collide).
  mkdirSync(join(routesDir, "gigs"), { recursive: true });
  writeFileSync(
    join(routesDir, "gigs", "[id].del.ts"),
    `import { Type } from "typebox";

export default async (ctx) => ctx.json({ deleted: true });
`,
  );
  writeFileSync(
    join(routesDir, "gigs", "[id].patch.ts"),
    `import { Type } from "typebox";

export const schema = { body: Type.Object({ title: Type.String() }) };

export default async (ctx) => ctx.json({ ok: true });
`,
  );

  // Query-schema route.
  writeFileSync(
    join(routesDir, "search.get.ts"),
    `import { Type } from "typebox";

export const schema = {
  query: Type.Object({ q: Type.String({ minLength: 1 }) }),
};

export default (ctx) => ctx.query;
`,
  );

  // Params + query route (path params substituted AND query serialized).
  mkdirSync(join(routesDir, "products"), { recursive: true });
  writeFileSync(
    join(routesDir, "products", "[id].get.ts"),
    `import { Type } from "typebox";

export const schema = {
  query: Type.Object({ q: Type.String() }),
};

export default (ctx) => ctx.query;
`,
  );

  const result = await buildAsync({
    routesDir,
    outDir,
    outFile: "server.js",
    incremental: false,
  });
  expect(result.errors).toHaveLength(0);
  return outDir;
};

describe("jsonSchemaToTs", () => {
  it("emits primitive types", () => {
    expect(jsonSchemaToTs({ type: "string" })).toBe("string");
    expect(jsonSchemaToTs({ type: "integer" })).toBe("number");
    expect(jsonSchemaToTs({ type: "boolean" })).toBe("boolean");
    expect(jsonSchemaToTs({ type: "null" })).toBe("null");
    expect(jsonSchemaToTs({})).toBe("unknown");
  });

  it("emits objects with required/optional properties", () => {
    const out = jsonSchemaToTs({
      type: "object",
      required: ["a"],
      properties: { a: { type: "string" }, b: { type: "number" } },
    });
    expect(out).toBe("{\n  a: string;\n  b?: number;\n}");
  });

  it("emits nested arrays and objects", () => {
    const out = jsonSchemaToTs({
      type: "object",
      properties: {
        rows: {
          type: "array",
          items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      },
    });
    expect(out).toContain("rows?: Array<{");
    expect(out).toContain("id: string;");
  });

  it("emits enums as literal unions", () => {
    expect(jsonSchemaToTs({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
  });

  it("emits const as a literal", () => {
    expect(jsonSchemaToTs({ const: "fixed" })).toBe('"fixed"');
  });

  it("emits oneOf/anyOf unions and nullable", () => {
    expect(jsonSchemaToTs({ anyOf: [{ type: "string" }, { type: "number" }] })).toBe(
      "string | number",
    );
    expect(jsonSchemaToTs({ type: "string", nullable: true })).toBe("string | null");
  });

  it("merges allOf object parts", () => {
    const out = jsonSchemaToTs({
      allOf: [
        { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
        { type: "object", properties: { b: { type: "number" } } },
      ],
    });
    expect(out).toContain("a: string;");
    expect(out).toContain("b?: number;");
  });

  it("resolves local $refs and degrades unknown refs to unknown", () => {
    const schemas: Record<string, unknown> = {
      Thing: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    };
    const resolve = (ref: string): unknown => {
      const name = ref.split("/").pop();
      return name !== undefined ? schemas[name] : undefined;
    };
    expect(
      jsonSchemaToTs({ $ref: "#/components/schemas/Thing" }, { resolveRef: resolve }),
    ).toContain("id: string;");
    expect(jsonSchemaToTs({ $ref: "#/components/schemas/Missing" }, { resolveRef: resolve })).toBe(
      "unknown",
    );
  });

  it("handles additionalProperties and empty objects", () => {
    expect(jsonSchemaToTs({ type: "object", additionalProperties: true })).toBe(
      "Record<string, unknown>",
    );
    expect(jsonSchemaToTs({ type: "object" })).toBe("Record<string, unknown>");
    const typed = jsonSchemaToTs({
      type: "object",
      properties: { tags: { type: "object", additionalProperties: { type: "string" } } },
    });
    expect(typed).toContain("tags?: Record<string, string>;");
  });
});

describe("SDK generation", () => {
  it("emits a self-contained TypeScript package with concrete types", async () => {
    const outDir = await buildSchemaFixture();
    const result = await generateSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript"],
    });

    expect(result.packages).toHaveLength(1);
    const pkg = result.packages[0];
    expect(pkg.platform).toBe("typescript");
    const files = new Map(pkg.files.map((f) => [f.path, f.content]));

    // package.json: name/version/exports/types.
    const manifest = JSON.parse(files.get("package.json") ?? "{}") as {
      name?: string;
      version?: string;
      types?: string;
      sideEffects?: boolean;
    };
    expect(manifest.name).toBe("@acme/api-sdk");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.types).toBe("./dist/index.d.ts");
    expect(manifest.sideEffects).toBe(false);

    // Concrete body type from the TypeBox schema (via openapi.json).
    const types = files.get("dist/types.d.ts") ?? "";
    expect(types).toContain("export type Body_PostOrders = {");
    expect(types).toContain("orderId: string;");
    expect(types).toContain("quantity: number;");
    expect(types).toContain("totalCents: number;");

    // Params fallback + typed response schema.
    expect(types).toContain("export type Params_GetReportsId = {");
    expect(types).toContain("id: string;");
    expect(types).toContain("export type Response_GetReportsId = {");
    expect(types).toContain("rows: Array<string>;");

    // Query schema typing.
    expect(types).toContain("export type Query_GetSearch = {");
    expect(types).toContain("q: string;");

    // Self-containment: no framework/app-source/typebox imports anywhere.
    const all = pkg.files.map((f) => f.content).join("\n");
    expect(all).not.toContain("@ignex/");
    expect(all).not.toContain("../src/");
    expect(all).not.toContain("typebox");
    expect(all).not.toContain('from "./routes.ts"');

    // routes.d.ts maps body/params/response into IgnexRoutes.
    const routes = files.get("dist/routes.d.ts") ?? "";
    expect(routes).toContain("body: Body_PostOrders;");
    expect(routes).toContain("params: Params_GetReportsId;");
    expect(routes).toContain("response: Response_GetReportsId;");

    // client.js: runtime client with zero imports + route dispatch.
    const client = files.get("dist/client.js") ?? "";
    expect(client).not.toMatch(/^\s*import\s/m);
    expect(client).toContain('"post /orders": "/orders"');
    // ROUTE_ARGS is keyed by the full "method path" (like ROUTES) so the same
    // route template with different per-method call shapes doesn't collide.
    expect(client).toContain('"post /orders": "body"');
    expect(client).toContain('"get /reports/:id": "params"');
    // Same template /gigs/:id: DELETE is params, PATCH is params+body — both
    // keys must be present (a bare-path key would collapse them).
    expect(client).toContain('"delete /gigs/:id": "params"');
    expect(client).toContain('"patch /gigs/:id": "params+body"');
    // Query-carrying routes get a dedicated call shape + URL serialization.
    expect(client).toContain('"get /search": "query"');
    expect(client).toContain("const buildQuery = (query) =>");
    expect(client).toContain("parts.push(");
    expect(client).toContain("encodeURIComponent(String(v))");
    expect(client).toContain("class ApiClientError");
    expect(client).toContain("export const createApiClient");

    // client.d.ts + entry re-exports.
    expect(files.get("dist/client.d.ts") ?? "").toContain(
      "export declare function createApiClient",
    );
    const index = files.get("dist/index.d.ts") ?? "";
    expect(index).toContain('export type { IgnexClient, IgnexRoutes } from "./routes";');
  });

  it("is deterministic across runs", async () => {
    const outDir = await buildSchemaFixture();
    const options = { outDir, name: "@acme/api-sdk", version: "1.2.3" };
    const a = await generateSdk(options);
    const b = await generateSdk(options);
    const content = (pkg: (typeof a.packages)[number]) =>
      pkg.files.map((f) => `${f.path}\n${f.content}`).join("\n");
    expect(content(a.packages[0])).toBe(content(b.packages[0]));
  });

  it("the generated client dispatches params/query/body per route at runtime", async () => {
    const outDir = await buildSchemaFixture();
    await writeSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript"],
      packageDir: join(outDir, "sdk-out"),
    });

    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: String(init?.method ?? "GET"),
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };

    const mod = (await import(join(outDir, "sdk-out", "dist", "client.js"))) as {
      createApiClient: (o: unknown) => Record<string, never>;
    };
    const client = mod.createApiClient({ baseUrl: "https://api.example", fetch: fakeFetch }) as {
      [path: string]: {
        get: (...a: unknown[]) => Promise<unknown>;
        del: (...a: unknown[]) => Promise<unknown>;
        patch: (...a: unknown[]) => Promise<unknown>;
        post: (...a: unknown[]) => Promise<unknown>;
      };
    };

    // params+query: template path + params object + query serialized.
    await client["/products/:id"]?.get({ id: "7" }, { q: "lamp" });
    expect(calls[calls.length - 1]?.url).toBe("https://api.example/products/7?q=lamp");

    // query-only.
    await client["/search"]?.get({ q: "hello world" });
    expect(calls[calls.length - 1]?.url).toBe("https://api.example/search?q=hello%20world");

    // body.
    await client["/orders"]?.post({ orderId: "o1", quantity: 2, totalCents: 100 });
    expect(calls[calls.length - 1]?.url).toBe("https://api.example/orders");
    expect(calls[calls.length - 1]?.body).toBe(
      JSON.stringify({ orderId: "o1", quantity: 2, totalCents: 100 }),
    );

    // Same template, different methods: del = params, patch = params+body.
    await client["/gigs/:id"]?.del({ id: "abc" });
    expect(calls[calls.length - 1]?.url).toBe("https://api.example/gigs/abc");
    expect(calls[calls.length - 1]?.body).toBeUndefined();
    await client["/gigs/:id"]?.patch({ id: "abc" }, { title: "new" });
    expect(calls[calls.length - 1]?.url).toBe("https://api.example/gigs/abc");
    expect(calls[calls.length - 1]?.body).toBe(JSON.stringify({ title: "new" }));
  });

  it("generates the openapi spec platform alongside typescript", async () => {
    const outDir = await buildSchemaFixture();
    const result = await generateSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript", "openapi"],
    });

    expect(result.packages.map((p) => p.platform)).toEqual(["typescript", "openapi"]);
    const [ts, spec] = result.packages;
    // Distinct directories; distinct names when multiple platforms.
    expect(ts.dir).not.toBe(spec.dir);
    const tsManifest = JSON.parse(
      ts.files.find((f) => f.path === "package.json")?.content ?? "{}",
    ) as {
      name?: string;
    };
    expect(tsManifest.name).toBe("@acme/api-sdk-typescript");

    const specFiles = new Map(spec.files.map((f) => [f.path, f.content]));
    expect(specFiles.get("openapi.json")).toContain('"openapi": "3.1.0"');
    const specManifest = JSON.parse(specFiles.get("package.json") ?? "{}") as { name?: string };
    expect(specManifest.name).toBe("@acme/api-sdk-openapi");
  });

  it("writes packages to disk and packs a tarball", async () => {
    const outDir = await buildSchemaFixture();
    const result = await writeSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript"],
    });
    const pkgDir = result.packages[0].dir;
    expect(existsSync(join(pkgDir, "package.json"))).toBe(true);
    expect(existsSync(join(pkgDir, "dist/client.js"))).toBe(true);

    const tarball = packSdk(pkgDir);
    expect(tarball).toMatch(/\.tgz$/);
    expect(existsSync(tarball)).toBe(true);
  });

  it("rejects unknown platforms and missing artifacts", async () => {
    const outDir = await buildSchemaFixture();
    await expect(generateSdk({ outDir, platforms: ["python" as never] })).rejects.toThrow(
      /Unknown SDK platform/,
    );

    const { outDir: empty } = materializeFixture("basic");
    expect(() => loadSdkInputs(empty)).toThrow(/run `ignex build` first/);
  });

  it("emits a local install path when no repo exists yet", async () => {
    const outDir = await buildSchemaFixture();
    const result = await generateSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript"],
      localInstallPath: "/home/dev/my-app/sdk",
    });
    const readme = result.packages[0].files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("## Local testing (before it is published)");
    expect(readme).toContain("npm install /home/dev/my-app/sdk");
    expect(readme).toContain("acme-api-sdk-1.2.3.tgz");
    // No GitHub install line without a repo URL.
    expect(readme).not.toContain("releases/download");
  });

  it("emits the GitHub release install line when a repo URL is known", async () => {
    const outDir = await buildSchemaFixture();
    const result = await generateSdk({
      outDir,
      name: "@acme/api-sdk",
      version: "1.2.3",
      platforms: ["typescript"],
      repoUrl: "https://github.com/acme/api",
    });
    const readme = result.packages[0].files.find((f) => f.path === "README.md")?.content ?? "";
    expect(readme).toContain("npm install @acme/api-sdk");
    expect(readme).toContain(
      "https://github.com/acme/api/releases/download/sdk-v1.2.3/acme-api-sdk-1.2.3.tgz",
    );
    const manifest = JSON.parse(
      result.packages[0].files.find((f) => f.path === "package.json")?.content ?? "{}",
    ) as { repository?: { url?: string } };
    expect(manifest.repository?.url).toBe("https://github.com/acme/api");
  });
});

describe("resolveRepoUrl", () => {
  it("derives the HTTPS repo URL from the origin remote", () => {
    const { outDir } = materializeFixture("basic");
    // Not a git repo → undefined.
    expect(resolveRepoUrl(outDir)).toBeUndefined();

    const repoDir = join(outDir, "repo");
    mkdirSync(repoDir);
    runSync("git", ["init", "-q"], repoDir);
    runSync("git", ["remote", "add", "origin", "git@github.com:acme/flux-core.git"], repoDir);
    expect(resolveRepoUrl(repoDir)).toBe("https://github.com/acme/flux-core");
    runSync("git", ["remote", "set-url", "origin", "https://github.com/acme/flux-core"], repoDir);
    expect(resolveRepoUrl(repoDir)).toBe("https://github.com/acme/flux-core");
  });
});
