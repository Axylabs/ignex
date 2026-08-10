/**
 * @fileoverview Smoke test for the generated app server.
 *
 * Boots `packages/app/dist/__server.js` as a child process, waits for it to
 * accept connections, then exercises the core routes and asserts their status
 * codes. Exits non-zero if the server fails to boot or any assertion fails.
 * Used by `bun run smoke` and the CI pipeline.
 *
 * Requires the app to be built first (`bun run build`).
 *
 * Env overrides:
 *   PORT — server port (default 3000; must match the generated server)
 *   BASE — base URL to hit (default `http://127.0.0.1:${PORT}`)
 */
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const PORT = Number(process.env.PORT ?? 3000);
const BASE = process.env.BASE ?? `http://127.0.0.1:${PORT}`;
const APP_DIR = new URL("../packages/app/", import.meta.url).pathname;

/** [label, path, expectedStatus] */
const CHECKS: Array<[string, string, number]> = [
  ["GET /health", "/health", 200],
  ["GET /hello", "/hello", 200],
  ["GET /products/123", "/products/123", 200],
  ["GET /missing-route", "/missing-route", 404],
];

const proc = spawn("bun", ["dist/__server.js"], {
  cwd: APP_DIR,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "pipe", "pipe"],
});

let procOutput = "";
proc.stdout.on("data", (d: Buffer) => (procOutput += d.toString()));
proc.stderr.on("data", (d: Buffer) => (procOutput += d.toString()));

/** Poll the health endpoint until the server accepts connections. */
const waitForServer = async (timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return;
    } catch {
      // server not up yet — keep polling
    }
    await delay(150);
  }
  throw new Error(`server did not become ready within ${timeoutMs}ms`);
};

let failed = false;
try {
  await waitForServer(10_000);
  for (const [label, path, expected] of CHECKS) {
    const res = await fetch(`${BASE}${path}`);
    const ok = res.status === expected;
    console.log(`${ok ? "PASS" : "FAIL"} ${label} → ${res.status} (expected ${expected})`);
    if (!ok) failed = true;
  }
} catch (err) {
  failed = true;
  console.error(`smoke failed: ${(err as Error).message}`);
} finally {
  proc.kill("SIGTERM");
  await delay(400);
  if (proc.exitCode === null) proc.kill("SIGKILL");
  if (failed) console.error(procOutput || "(no server output)");
  process.exit(failed ? 1 : 0);
}
