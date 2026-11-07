/**
 * SDK regeneration round-trip — generate a FRESH typed client package from
 * the compiled matrix fixture's artifacts (`writeSdk`) and drive it against
 * the live compiled server.
 *
 * `client.integration.test.ts` proves the COMMITTED generated client works;
 * this suite proves the GENERATOR still emits a working client from current
 * artifacts — catching generation drift (template changes in the compiler's
 * SDK phases) that the committed copy cannot see.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { writeSdk } from "@ignex/compiler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot.js";

/** Written inside the repo so vitest's TS transform applies to the import. */
const REGEN_DIR = join(MATRIX_FIXTURE, "..", ".sdk-regen-e2e");
const OUT_DIR = join(MATRIX_FIXTURE, "dist");

/** The generated client's route surface (`client[path][method](...)`). */
type ApiClient = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

let server: BootedServer;
let createApiClient: (options: { baseUrl: string }) => ApiClient;

/** Invoke a route through the generated client surface. */
const routeCall = (
  client: ApiClient,
  path: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => {
  const route = client[path];
  if (route === undefined) throw new Error(`generated client has no route ${path}`);
  const fn = route[method];
  if (typeof fn !== "function") throw new Error(`generated client route ${path} has no ${method}`);
  return fn(...args);
};

beforeAll(async () => {
  rmSync(REGEN_DIR, { recursive: true, force: true });
  server = await bootServer(MATRIX_FIXTURE, { rebuild: true });

  // Generate a fresh SDK package from the just-compiled artifacts.
  const result = await writeSdk({
    outDir: OUT_DIR,
    packageDir: REGEN_DIR,
    name: "@ignex/regen-sdk",
    version: "0.0.0-e2e",
    platforms: ["typescript"],
  });
  expect(result.packages).toHaveLength(1);

  // The typescript platform emits dist/client.js (+ d.ts siblings).
  const mod = (await import(pathToFileURL(join(REGEN_DIR, "dist", "client.js")).href)) as {
    createApiClient: (options: { baseUrl: string }) => ApiClient;
  };
  createApiClient = mod.createApiClient;
});

afterAll(async () => {
  server.close();
  rmSync(REGEN_DIR, { recursive: true, force: true });
});

describe("freshly generated SDK package against the compiled server", () => {
  it("emits the npm-package layout with non-trivial artifacts", () => {
    expect(existsSync(join(REGEN_DIR, "package.json"))).toBe(true);
    expect(existsSync(join(REGEN_DIR, "dist", "index.d.ts"))).toBe(true);
    const types = readFileSync(join(REGEN_DIR, "dist", "types.d.ts"), "utf8");
    expect(types.length).toBeGreaterThan(200);
    const manifest = JSON.parse(readFileSync(join(REGEN_DIR, "package.json"), "utf8")) as {
      name?: string;
      version?: string;
      types?: string;
    };
    expect(manifest.name).toBe("@ignex/regen-sdk");
    expect(manifest.version).toBe("0.0.0-e2e");
    expect(manifest.types).toBe("./dist/index.d.ts");
  });

  it("GET /health round-trips through the regenerated client", async () => {
    const client = createApiClient({ baseUrl: server.base });
    await expect(routeCall(client, "/health", "get")).resolves.toEqual({ status: "ok" });
  });

  it("params URL-encode through the regenerated client", async () => {
    const client = createApiClient({ baseUrl: server.base });
    await expect(routeCall(client, "/users/:id", "get", { id: "a b/42" })).resolves.toEqual({
      id: "a b/42",
    });
  });

  it("POST bodies round-trip through the regenerated client", async () => {
    const client = createApiClient({ baseUrl: server.base });
    const res = (await routeCall(client, "/body", "post", { hello: "world" })) as {
      value: Record<string, unknown>;
    };
    expect(res.value).toEqual({ hello: "world" });
  });

  it("missing routes still throw a status-carrying error", async () => {
    const client = createApiClient({ baseUrl: server.base });
    await expect(routeCall(client, "/definitely-missing", "get")).rejects.toMatchObject({
      status: 404,
    });
  });
});
