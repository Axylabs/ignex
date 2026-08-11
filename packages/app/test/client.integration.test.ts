/**
 * E2E: the compiler-generated SDK client (`client.ts`) against a real
 * AOT-compiled server.
 *
 * Builds the request-matrix fixture app fresh into a throwaway in-repo dir
 * (Bun resolves `@ignus/*` via the root tsconfig `paths`), so this suite always
 * exercises the CURRENT generator and never races the other matrix suites over
 * the shared `matrix/dist`. It then drives the server exclusively through the
 * generated `createApiClient` — proving the SDK surface `ignus build` produces
 * actually works against compiled code: params, JSON bodies, header merging,
 * ROUTES-key access, and error throwing on non-2xx.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot.js";

/** Throwaway build dir, sibling to the committed matrix fixture. */
const E2E_DIR = join(MATRIX_FIXTURE, "..", ".client-e2e");

type ApiClient = {
  [path: string]: { [method: string]: (...args: unknown[]) => Promise<unknown> };
};

let server: BootedServer;
let createApiClient: (baseUrl?: string, init?: RequestInit) => ApiClient;

beforeAll(async () => {
  rmSync(E2E_DIR, { recursive: true, force: true });
  cpSync(join(MATRIX_FIXTURE, "src"), join(E2E_DIR, "src"), { recursive: true });
  cpSync(join(MATRIX_FIXTURE, "builder.ts"), join(E2E_DIR, "builder.ts"));

  const build = spawnSync("bun", ["builder.ts"], { cwd: E2E_DIR, stdio: "pipe" });
  expect(
    build.status,
    `matrix e2e build failed:\n${build.stderr?.toString() ?? build.stdout?.toString()}`,
  ).toBe(0);
  expect(existsSync(join(E2E_DIR, "dist", "client.ts"))).toBe(true);

  const mod = (await import(pathToFileURL(join(E2E_DIR, "dist", "client.ts")).href)) as {
    createApiClient: (baseUrl?: string, init?: RequestInit) => ApiClient;
  };
  createApiClient = mod.createApiClient;

  server = await bootServer(E2E_DIR);
});

afterAll(() => {
  server?.close();
  rmSync(E2E_DIR, { recursive: true, force: true });
});

describe("generated client against compiled server (E2E)", () => {
  it("GET /health via the generated client", async () => {
    const client = createApiClient(server.base);
    await expect(client["/health"].get()).resolves.toEqual({ status: "ok" });
  });

  it("URL-encodes params into /users/:id", async () => {
    const client = createApiClient(server.base);
    await expect(client["/users/:id"].get({ id: "a b/42" })).resolves.toEqual({ id: "a b/42" });
  });

  it("POSTs a JSON body to /body", async () => {
    const client = createApiClient(server.base);
    const res = (await client["/body"].post({ hello: "world" })) as {
      value: Record<string, unknown>;
    };
    expect(res.value).toEqual({ hello: "world" });
  });

  it('supports ROUTES-key access ("get /health")', async () => {
    const client = createApiClient(server.base);
    await expect(client["get /health"].get()).resolves.toEqual({ status: "ok" });
  });

  it("throws a status-carrying Error on 404", async () => {
    const client = createApiClient(server.base);
    await expect(client["/definitely-missing"].get()).rejects.toMatchObject({ status: 404 });
  });

  it("merges client-wide and per-call headers (deep merge)", async () => {
    const client = createApiClient(server.base, { headers: { "x-test": "from-base" } });
    const res = (await client["/headers"].get({ headers: { "x-multi": "from-call" } })) as {
      headers: Record<string, string>;
    };
    expect(res.headers["x-test"]).toBe("from-base");
    expect(res.headers["x-multi"]).toBe("from-call");
  });
});
