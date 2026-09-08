/**
 * E2E: the compiler-generated SDK client (`client.ts`) against a real
 * AOT-compiled server.
 *
 * Builds the request-matrix fixture app fresh into a throwaway in-repo dir
 * (Bun resolves `@ignex/*` via the root tsconfig `paths`), so this suite always
 * exercises the CURRENT generator and never races the other matrix suites over
 * the shared `matrix/dist`. It then drives the server exclusively through the
 * generated `createApiClient` — proving the SDK surface `ignex build` produces
 * actually works against compiled code: params, JSON bodies, header merging,
 * ROUTES-key access, and error throwing on non-2xx.
 */
import { type ChildProcess, spawnSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type BootedServer, bootServer, MATRIX_FIXTURE } from "./helpers/boot.js";

/** Throwaway build dir, sibling to the committed matrix fixture. */
const E2E_DIR = join(MATRIX_FIXTURE, "..", ".client-e2e");

/** How long to wait for the booted server process to actually exit. */
const CHILD_EXIT_TIMEOUT_MS = 5000;
/** rmSync retry budget around transient Windows EBUSY/EPERM handle locks. */
const REMOVE_ATTEMPTS = 10;
const REMOVE_RETRY_DELAY_MS = 100;

/**
 * Remove a directory, retrying around transient Windows errors. `rmdir` fails
 * with EBUSY/EPERM while a just-killed child process still holds the directory
 * as its cwd (or AV is scanning freshly-written build output) — the OS
 * releases the handle a moment after the process actually exits.
 */
const removeDir = async (dir: string): Promise<void> => {
  let lastError: unknown;
  for (let attempt = 0; attempt <= REMOVE_ATTEMPTS; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      const transient =
        code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY" || code === "EACCES";
      if (!transient) break;
      await delay(REMOVE_RETRY_DELAY_MS);
    }
  }
  throw lastError;
};

type ApiClient = {
  [path: string]: { [method: string]: (...args: unknown[]) => Promise<unknown> };
};

/**
 * Look up a route method on the generated client, asserting it exists so a
 * generator regression fails with a clear message instead of a TypeError.
 */
const routeCall = (
  client: ApiClient,
  path: string,
  method: string,
  ...args: unknown[]
): Promise<unknown> => {
  const route = client[path];
  if (route === undefined) {
    throw new Error(`generated client has no route ${path}`);
  }
  const fn = route[method];
  if (typeof fn !== "function") {
    throw new Error(`generated client route ${path} has no ${method}`);
  }
  return fn(...args);
};

let server: BootedServer;
let createApiClient: (baseUrl?: string, init?: RequestInit) => ApiClient;

beforeAll(async () => {
  // Retry in case a previous interrupted run left a child still holding E2E_DIR.
  await removeDir(E2E_DIR);
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

afterAll(async () => {
  // `close()` only *signals* the child (`proc.kill`); on Windows termination
  // — and the release of the child's cwd (E2E_DIR) — is asynchronous. Wait for
  // the server to actually exit before removing E2E_DIR, or rmdir races a
  // still-live process → EBUSY.
  const proc: ChildProcess | undefined = server?.proc;
  server?.close();
  if (proc !== undefined) {
    const deadline = Date.now() + CHILD_EXIT_TIMEOUT_MS;
    while (Date.now() < deadline && proc.exitCode === null && proc.signalCode === null) {
      await delay(25);
    }
  }
  await removeDir(E2E_DIR);
});

describe("generated client against compiled server (E2E)", () => {
  it("GET /health via the generated client", async () => {
    const client = createApiClient(server.base);
    await expect(routeCall(client, "/health", "get")).resolves.toEqual({ status: "ok" });
  });

  it("URL-encodes params into /users/:id", async () => {
    const client = createApiClient(server.base);
    await expect(routeCall(client, "/users/:id", "get", { id: "a b/42" })).resolves.toEqual({
      id: "a b/42",
    });
  });

  it("POSTs a JSON body to /body", async () => {
    const client = createApiClient(server.base);
    const res = (await routeCall(client, "/body", "post", { hello: "world" })) as {
      value: Record<string, unknown>;
    };
    expect(res.value).toEqual({ hello: "world" });
  });

  it('supports ROUTES-key access ("get /health")', async () => {
    const client = createApiClient(server.base);
    await expect(routeCall(client, "get /health", "get")).resolves.toEqual({ status: "ok" });
  });

  it("throws a status-carrying Error on 404", async () => {
    const client = createApiClient(server.base);
    await expect(routeCall(client, "/definitely-missing", "get")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("merges client-wide and per-call headers (deep merge)", async () => {
    const client = createApiClient(server.base, { headers: { "x-test": "from-base" } });
    const res = (await routeCall(client, "/headers", "get", {
      headers: { "x-multi": "from-call" },
    })) as {
      headers: Record<string, string>;
    };
    expect(res.headers["x-test"]).toBe("from-base");
    expect(res.headers["x-multi"]).toBe("from-call");
  });
});
