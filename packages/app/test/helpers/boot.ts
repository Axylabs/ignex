/**
 * @fileoverview Shared boot harness for AOT-compiled server integration tests.
 *
 * Every integration suite (the existing `server.integration.test.ts` and the
 * request-handling matrix suites) boots the compiler-generated server the same
 * way, so that logic lives here once:
 *
 *   1. compile the app if `dist/__server.js` is missing (`bun builder.ts`),
 *   2. spawn it on an OS-assigned free port with overridable env,
 *   3. poll `/health` until it responds (or fail with a clear error).
 *
 * Ports are collision-free across parallel vitest workers: instead of a shared
 * random range (two suites could pick the same port — the loser's server would
 * die at bind while its health poll kept hitting the winner's server, so the
 * loser would run its whole suite against a server it doesn't own and lose it
 * mid-test when the winner closed), each boot asks the OS for a free port, and
 * retries with a fresh port if the child dies before becoming ready. AOT
 * rebuilds (`rebuild: true`) are serialized with a lockfile so two suites never
 * rewrite the same `dist/__server.js` concurrently.
 *
 * Usage:
 * ```ts
 * const srv = await bootServer(FIXTURE_DIR, { env: { PORT: "0" } });
 * try { …fetch(srv.base)… } finally { srv.close(); }
 * ```
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import type { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { type AddressInfo, createServer as createNetServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface BootOptions {
  /** Bind port. Defaults to an OS-assigned free port (collision-free across suites). */
  port?: number;
  /**
   * Base URL scheme. Use `"https"` when the app serves HTTPS by default
   * (ignex's default — TLS with auto-generated dev certs). Defaults to
   * `"http"` (fixtures that set `server.https: false`).
   */
  protocol?: "http" | "https";
  /** Extra environment variables for the server process. */
  env?: Record<string, string>;
  /** Force an AOT rebuild even when `dist/__server.js` already exists. */
  rebuild?: boolean;
  /** Spawn attempts (fresh port each time). Default 3. */
  retries?: number;
}

export interface BootedServer {
  /** Base URL, e.g. `http://127.0.0.1:3456`. */
  base: string;
  /** The spawned server process (exposed for diagnostics / debugging). */
  proc: ChildProcess;
  /** Terminate the server process (idempotent). */
  close(): void;
}

const READY_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 200;
const MAX_BOOT_ATTEMPTS = 3;
/** Lockfile name held while a worker AOT-compiles a shared fixture's dist. */
const BUILD_LOCK = ".ignex-build.lock";

/**
 * Every generated-server suite talks to a locally-bound dev server that may
 * serve HTTPS over a self-signed cert (ignex's default). The vitest worker
 * runs on Node (undici fetch), which rejects self-signed certs and ignores
 * Bun's per-request `tls: { rejectUnauthorized: false }` — so disable TLS
 * verification for the worker once. This only affects the test process.
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

/** Absolute path to the request-handling matrix fixture app. */
export const MATRIX_FIXTURE = new URL("../fixtures/matrix", import.meta.url).pathname;

/** Run the fixture's AOT build (`bun builder.ts`). */
const runBuild = (appDir: string): void => {
  const build = spawnSync("bun", ["builder.ts"], {
    cwd: appDir,
    stdio: "ignore",
  });
  if (build.status !== 0) {
    throw new Error(`app build failed in ${appDir} with code ${build.status}`);
  }
};

/**
 * Serialize AOT builds of a shared fixture dir across parallel workers.
 * `mkdir` is atomic, so exactly one worker holds the lock; the others wait.
 * Prevents two `rebuild: true` suites (parity, ws-e2e) from concurrently
 * rewriting the same `dist/__server.js` and corrupting each other's build.
 */
const withBuildLock = async <T>(appDir: string, fn: () => T): Promise<T> => {
  const lockPath = join(appDir, BUILD_LOCK);
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch {
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for build lock in ${appDir}`);
      }
      await delay(100);
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
};

/** AOT-compile an app if its generated server is not present (locked). */
const ensureBuilt = (appDir: string): Promise<void> =>
  withBuildLock(appDir, () => {
    // Re-check under the lock: another worker may have built it while we waited.
    if (existsSync(join(appDir, "dist", "__server.js"))) return;
    runBuild(appDir);
  });

/** Force a fresh AOT build (used by parity suites that compare current code). */
const forceBuild = (appDir: string): Promise<void> => withBuildLock(appDir, () => runBuild(appDir));

/**
 * Minimal shape of a port probe. `createNetServer()` returns a fully-typed
 * `Server`, but the EventEmitter surface @types/node exposes on it varies by
 * version (v26 classes switched from `extends EventEmitter` to `implements`
 * without redeclaring `once`), so cast to the methods this helper actually
 * needs to keep the suite compiling on any installed @types/node.
 */
interface PortProbe extends EventEmitter {
  listen(port: number, host: string, callback: () => void): void;
  address(): AddressInfo | string | null;
  close(callback?: () => void): void;
}

/**
 * Ask the OS for a currently-free TCP port and release it for the child to
 * bind. The window between release and bind is tiny; `bootServer` retries with
 * a fresh port when the child fails to come up, so parallel suites never share
 * a port.
 */
const freePort = (): Promise<number> =>
  new Promise<number>((resolve, reject) => {
    // `as unknown as`: the resolved @types/node `Server` type may not expose
    // the EventEmitter surface at all — see the PortProbe comment above.
    const probe = createNetServer() as unknown as PortProbe;
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });

/** Outcome of one spawn attempt: a ready server, or a diagnostic failure. */
type BootAttempt = { ok: true; base: string; proc: ChildProcess } | { ok: false; failure: string };

/**
 * Spawn the compiled server on `port` and wait until it serves `/health` or
 * the child exits. Kills the child and returns the failure reason otherwise.
 */
const bootAttempt = async (
  appDir: string,
  port: number,
  protocol: "http" | "https",
  env: Record<string, string> = {},
): Promise<BootAttempt> => {
  const base = `${protocol}://127.0.0.1:${port}`;
  const proc = spawn("bun", ["dist/__server.js"], {
    cwd: appDir,
    env: { ...process.env, ...env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Keep the child's stderr for a diagnostic error if boot never succeeds.
  let stderr = "";
  proc.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // The child exits (bind failure, corrupted dist, …) → fail this attempt.
    // Polled via `exitCode`/`signalCode` — the event-based `once("exit")` is
    // unavailable on some @types/node versions.
    if (proc.exitCode !== null || proc.signalCode !== null) {
      proc.kill("SIGTERM");
      const reason = proc.exitCode !== null ? `code ${proc.exitCode}` : `signal ${proc.signalCode}`;
      return {
        ok: false,
        failure: `server exited during boot (${reason}).\nstderr:\n${stderr.trim()}`,
      };
    }
    try {
      const res = await fetch(`${base}/health`);
      if (res.status === 200) {
        return { ok: true, base, proc };
      }
    } catch {
      // not up yet — keep polling
    }
    await delay(POLL_INTERVAL_MS);
  }

  proc.kill("SIGTERM");
  return { ok: false, failure: `server never became ready.\nstderr:\n${stderr.trim()}` };
};

/**
 * Compile-if-needed and boot a generated ignex server, waiting for it to
 * become ready. Throws (after killing the child) if it never responds.
 */
export const bootServer = async (
  appDir: string,
  options: BootOptions = {},
): Promise<BootedServer> => {
  if (options.rebuild) await forceBuild(appDir);
  else await ensureBuilt(appDir);

  const protocol = options.protocol ?? "http";
  const attempts = options.retries ?? MAX_BOOT_ATTEMPTS;
  const env = options.env ?? {};

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const port = options.port ?? (await freePort());
    const result = await bootAttempt(appDir, port, protocol, env);

    if (result.ok) {
      const { base, proc } = result;
      return { base, proc, close: () => proc.kill("SIGTERM") };
    }

    if (attempt === attempts) {
      throw new Error(
        `generated server in ${appDir} did not become ready after ${attempts} attempt(s) — ${result.failure}`,
      );
    }
    // A server dying at startup usually means the released port was re-grabbed
    // in the TOCTOU window or the dist was mid-rebuild — retry on a fresh port.
    await delay(200);
  }
  throw new Error(`generated server in ${appDir} did not become ready`);
};
