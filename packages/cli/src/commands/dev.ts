import { type ChildProcess, spawn as spawnProcess, spawnSync } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { relative, resolve } from "node:path";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { buildProject, findServerEntry } from "../utils/compiler.js";
import { CONFIG_FILES, loadConfig } from "../utils/config.js";
import { isValidPort, shouldIgnore } from "../utils/dev.js";
import { error, formatError, step, success, warn } from "../utils/logger.js";
import { detectRuntime } from "../utils/runtime.js";

/** Debounce window for rebuilds triggered by file events (ms). */
const REBUILD_DEBOUNCE_MS = 120;
/** Consecutive crash restarts before giving up and waiting for a file change. */
const MAX_CRASH_RESTARTS = 5;
/** Base delay for crash-restart backoff (doubled per attempt, capped at 5s). */
const CRASH_RESTART_BASE_MS = 250;
/** A server that stays up this long is considered healthy (resets the crash counter). */
const HEALTHY_THRESHOLD_MS = 2_000;

export async function runDev(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    port: { type: "string" },
    runtime: { type: "string" },
    spawn: { type: "boolean" },
    outDir: { type: "string" },
    routesDir: { type: "string" },
    minify: { type: "boolean" },
    sourcemap: { type: "boolean" },
    verbose: { type: "boolean" },
  });

  const root = resolveRoot(values, positionals);
  const runtime = detectRuntime(values.runtime as string | undefined);
  const port = (values.port as string | undefined) ?? process.env.PORT ?? "3000";
  // In Bun, node:util/parseArgs turns `--no-spawn` into the literal "no-spawn"
  // key (not `values.spawn === false`), so check it explicitly.
  const noSpawn = (values as Record<string, unknown>)["no-spawn"] === true;
  const shouldSpawn = values.spawn !== false && !noSpawn;

  if (!isValidPort(port)) {
    warn(`Invalid port "${port}" — defaulting to 3000`);
  }

  const config = await loadConfig(root);
  const outDir = String(values.outDir ?? config.outDir ?? ".flux");

  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let crashRestartTimer: NodeJS.Timeout | undefined;
  let building = false;
  let pending = false;
  let stopping = false;
  let stoppingChild = false;
  let crashRestartAttempts = 0;
  let lastBuildFailed = false;

  const watchers: FSWatcher[] = [];

  /** Send SIGTERM to the child's process group (taskkill on Windows). */
  function killProcess(pid: number | undefined): void {
    if (process.platform === "win32") {
      if (pid) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    if (!pid) return;
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // noop
      }
    }
  }

  /**
   * Stop the current child and await its exit so the port is released before a
   * new server spawns (avoids the EADDRINUSE restart race). Falls back to
   * SIGKILL after 2s.
   */
  function stopChild(): Promise<void> {
    const current = child;
    if (!current) return Promise.resolve();

    // Already exited — nothing left to stop.
    if (current.exitCode !== null || current.signalCode !== null) {
      child = undefined;
      return Promise.resolve();
    }

    stoppingChild = true;

    const exited = new Promise<void>((resolveExit) => {
      current.once("exit", () => resolveExit());
      const force = setTimeout(() => {
        try {
          current.kill("SIGKILL");
        } catch {
          // noop
        }
      }, 2_000);
      force.unref?.();
    });

    killProcess(current.pid);

    return exited.then(() => {
      stoppingChild = false;
      child = undefined;
    });
  }

  function startChild(entry: string): ChildProcess {
    step(`Starting ${relative(process.cwd(), entry)} with ${runtime}`);

    const spawned = spawnProcess(runtime, [entry], {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: "development",
      },
    });

    child = spawned;

    // A server that survives past the healthy threshold resets the crash
    // counter so a sustained runtime fault doesn't accumulate across restarts.
    const healthTimer = setTimeout(() => {
      crashRestartAttempts = 0;
    }, HEALTHY_THRESHOLD_MS);
    healthTimer.unref?.();

    spawned.on("exit", (code, signal) => {
      clearTimeout(healthTimer);
      if (child === spawned) child = undefined;

      // Intentional stop or no server process — never auto-restart.
      if (stopping || stoppingChild || !shouldSpawn) return;
      // Clean exit (code 0) — nothing to do.
      if (code === 0) return;

      crashRestartAttempts += 1;

      if (crashRestartAttempts > MAX_CRASH_RESTARTS) {
        warn(
          `Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
            `Giving up after ${MAX_CRASH_RESTARTS} rapid restarts — it may be crashing on ` +
            `boot (e.g. the port is already in use). Waiting for a file change to retry.`,
        );
        return;
      }

      const delay = Math.min(CRASH_RESTART_BASE_MS * 2 ** (crashRestartAttempts - 1), 5_000);
      warn(
        `Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
          `Restarting in ${delay}ms (attempt ${crashRestartAttempts}/${MAX_CRASH_RESTARTS}).`,
      );

      crashRestartTimer = setTimeout(() => {
        if (stopping) return;
        child = startChild(entry);
      }, delay);
    });

    return spawned;
  }

  async function restart(entry: string): Promise<void> {
    await stopChild();
    child = startChild(entry);
  }

  async function buildOnce(): Promise<void> {
    if (building) {
      pending = true;
      return;
    }

    building = true;

    try {
      const { opts } = await buildProject(root, values as Record<string, unknown>);
      const entry = await findServerEntry(root, opts);

      if (!entry) {
        warn("Could not locate generated server entry. Set outDir/output or run with --no-spawn.");
      } else if (shouldSpawn) {
        await restart(entry);
      }

      lastBuildFailed = false;
      crashRestartAttempts = 0;
      success("Build ok — server is up to date");
    } catch (err) {
      lastBuildFailed = true;
      error(formatError(err));
      warn(
        "Build failed — the running server (if any) is still serving the previous build. " +
          "Fix the error and save a file to rebuild.",
      );
    } finally {
      building = false;

      if (pending) {
        pending = false;
        await buildOnce();
      }
    }
  }

  function scheduleRebuild(): void {
    if (timer) clearTimeout(timer);

    timer = setTimeout(() => {
      void buildOnce();
    }, REBUILD_DEBOUNCE_MS);
  }

  async function shutdown(): Promise<void> {
    if (stopping) return;
    stopping = true;

    if (timer) clearTimeout(timer);
    if (crashRestartTimer) clearTimeout(crashRestartTimer);
    for (const watcher of watchers) watcher.close();

    await stopChild();
    process.exit(lastBuildFailed ? 1 : 0);
  }

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // Attach watchers before the initial build so changes made during the first
  // (potentially slow) build are not missed.
  setupWatchers();

  await buildOnce();

  success(
    shouldSpawn
      ? "Watching for changes — press Ctrl+C to stop."
      : "Watching for changes (--no-spawn; no server process).",
  );

  /** Watch the project for changes; debounced rebuilds via `scheduleRebuild`. */
  function setupWatchers(): void {
    try {
      const watcher = watch(root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (shouldIgnore(String(filename), outDir, root)) return;
        scheduleRebuild();
      });

      watcher.on("error", () => {
        // Ignore watch errors; rebuilds are debounced.
      });

      watchers.push(watcher);
    } catch {
      warn(
        "Recursive fs.watch unavailable. Watching src/, routes/, hooks/, and config files non-recursively.",
      );

      const routesDir = String(config.routesDir ?? "src/routes");
      const hooksDir = String(config.hooksDir ?? "src/hooks");

      const dirs = [routesDir, hooksDir, "src"].map((dir) => resolve(root, dir));

      for (const dir of dirs) {
        try {
          const watcher = watch(dir, (_event, filename) => {
            if (!filename) return;
            // Resolve against the watched dir so shouldIgnore sees absolute paths.
            if (shouldIgnore(resolve(dir, String(filename)), outDir, root)) return;
            scheduleRebuild();
          });

          watcher.on("error", () => {
            // noop
          });

          watchers.push(watcher);
        } catch {
          // Directory may not exist.
        }
      }

      // Single source of truth for config files (includes flux.config.json).
      for (const file of CONFIG_FILES) {
        try {
          const watcher = watch(resolve(root, file), () => {
            scheduleRebuild();
          });

          watcher.on("error", () => {
            // noop
          });

          watchers.push(watcher);
        } catch {
          // File may not exist.
        }
      }

      try {
        const watcher = watch(resolve(root, "package.json"), () => {
          scheduleRebuild();
        });

        watcher.on("error", () => {
          // noop
        });

        watchers.push(watcher);
      } catch {
        // File may not exist.
      }
    }
  }
}
