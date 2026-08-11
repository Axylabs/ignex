/**
 * @fileoverview Shared boot harness for AOT-compiled server integration tests.
 *
 * Every integration suite (the existing `server.integration.test.ts` and the
 * request-handling matrix suites) boots the compiler-generated server the same
 * way, so that logic lives here once:
 *
 *   1. compile the app if `dist/__server.js` is missing (`bun builder.ts`),
 *   2. spawn it on an ephemeral port with overridable env,
 *   3. poll `/health` until it responds (or fail with a clear error).
 *
 * Usage:
 * ```ts
 * const srv = await bootServer(FIXTURE_DIR, { env: { PORT: "0" } });
 * try { …fetch(srv.base)… } finally { srv.close(); }
 * ```
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BootOptions {
  /** Bind port. Defaults to a random port in the 3100–3499 range. */
  port?: number;
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
}

export interface BootedServer {
  /** Base URL, e.g. `http://127.0.0.1:3456`. */
  base: string;
  /** The spawned server process (exposed for diagnostics / debugging). */
  proc: ReturnType<typeof spawn>;
  /** Terminate the server process (idempotent). */
  close(): void;
}

const READY_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 200;

/** Absolute path to the request-handling matrix fixture app. */
export const MATRIX_FIXTURE = new URL("../fixtures/matrix", import.meta.url).pathname;

/** AOT-compile an app if its generated server is not present. */
const ensureBuilt = (appDir: string): void => {
  if (existsSync(join(appDir, "dist", "__server.js"))) return;
  const build = spawnSync("bun", ["builder.ts"], {
    cwd: appDir,
    stdio: "ignore",
  });
  if (build.status !== 0) {
    throw new Error(`app build failed in ${appDir} with code ${build.status}`);
  }
};

/**
 * Compile-if-needed and boot a generated ignus server, waiting for it to
 * become ready. Throws (after killing the child) if it never responds.
 */
export const bootServer = async (
  appDir: string,
  options: BootOptions = {},
): Promise<BootedServer> => {
  ensureBuilt(appDir);

  const port = options.port ?? 3100 + Math.floor(Math.random() * 200);
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn("bun", ["dist/__server.js"], {
    cwd: appDir,
    env: { ...process.env, ...options.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) {
        return { base, proc, close: () => proc.kill("SIGTERM") };
      }
    } catch {
      // not up yet — keep polling
    }
    await delay(POLL_INTERVAL_MS);
  }

  proc.kill("SIGTERM");
  throw new Error(`generated server in ${appDir} did not become ready`);
};
