/**
 * Generated-server integration tests.
 *
 * Boots the AOT-compiled server (`dist/__server.js`) on an ephemeral port and
 * exercises the core routes end-to-end. Builds the app first if the output is
 * missing (e.g. a fresh-clone test run), so the test is self-contained.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const APP_DIR = new URL("../", import.meta.url).pathname;
const SERVER = `${APP_DIR}dist/__server.js`;
const PORT = 3100 + Math.floor(Math.random() * 200);
const BASE = `http://127.0.0.1:${PORT}`;

let proc: ReturnType<typeof spawn> | null = null;

/** AOT-compile the app if the generated server is not present. */
const ensureBuilt = (): void => {
  if (existsSync(SERVER)) return;
  const build = spawnSync("bun", ["builder.ts"], {
    cwd: APP_DIR,
    stdio: "ignore",
  });
  if (build.status !== 0) {
    throw new Error(`app build failed with code ${build.status}`);
  }
};

beforeAll(async () => {
  ensureBuilt();

  proc = spawn("bun", ["dist/__server.js"], {
    cwd: APP_DIR,
    env: { ...process.env, PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return;
    } catch {
      // not up yet — keep polling
    }
    await delay(200);
  }
  throw new Error("generated server did not become ready");
});

afterAll(() => {
  proc?.kill("SIGTERM");
});

describe("generated server (integration)", () => {
  it("serves GET /health with a JSON body", async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status?: string };
    expect(body.status).toBe("ok");
  });

  it("serves GET /hello (named-export handler)", async () => {
    const res = await fetch(`${BASE}/hello`);
    expect(res.status).toBe(200);
  });

  it("serves GET /products/:id with a dynamic param", async () => {
    const res = await fetch(`${BASE}/products/42`);
    expect(res.status).toBe(200);
  });

  it("404s unknown routes", async () => {
    const res = await fetch(`${BASE}/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
