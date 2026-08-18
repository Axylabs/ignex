import { type ChildProcess, spawn as spawnProcess, spawnSync } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { relative, resolve } from "node:path";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { buildProject, findServerEntry } from "../utils/compiler.js";
import { CONFIG_FILES, loadConfig } from "../utils/config.js";
import { isValidPort, shouldIgnore } from "../utils/dev.js";
import { checkProjectEnv, reportEnvCheck } from "../utils/env-check.js";
import { error, formatError, info, step, success, warn } from "../utils/logger.js";
import { nativeLabel, nativeStatus } from "../utils/native.js";
import { detectRuntime } from "../utils/runtime.js";

/** Debounce window for rebuilds triggered by file events (ms). */
const REBUILD_DEBOUNCE_MS = 120;
/** Consecutive crash restarts before giving up and waiting for a file change. */
const MAX_CRASH_RESTARTS = 5;
/** Base delay for crash-restart backoff (doubled per attempt, capped at 5s). */
const CRASH_RESTART_BASE_MS = 250;
/** A server that stays up this long is considered healthy (resets the crash counter). */
const HEALTHY_THRESHOLD_MS = 2_000;

/** Raw CLI values forwarded to {@link buildProject}. */
type BuildArgs = Record<string, unknown>;

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

/** Runtime state + lifecycle for the `dev` command (build / watch / spawn). */
class DevServer {
  private readonly root: string;
  private readonly runtime: string;
  private readonly port: string;
  private readonly shouldSpawn: boolean;
  private readonly outDir: string;
  private readonly config: Awaited<ReturnType<typeof loadConfig>>;
  private readonly buildArgs: BuildArgs;
  private readonly watchers: FSWatcher[] = [];

  private child: ChildProcess | undefined;
  private timer: NodeJS.Timeout | undefined;
  private crashRestartTimer: NodeJS.Timeout | undefined;
  private building = false;
  private pending = false;
  private stopping = false;
  private stoppingChild = false;
  private crashRestartAttempts = 0;
  private lastBuildFailed = false;

  constructor(opts: {
    root: string;
    runtime: string;
    port: string;
    shouldSpawn: boolean;
    outDir: string;
    config: Awaited<ReturnType<typeof loadConfig>>;
    buildArgs: BuildArgs;
  }) {
    this.root = opts.root;
    this.runtime = opts.runtime;
    this.port = opts.port;
    this.shouldSpawn = opts.shouldSpawn;
    this.outDir = opts.outDir;
    this.config = opts.config;
    this.buildArgs = opts.buildArgs;
  }

  /** Install signal handlers, watch, and run the initial build. */
  async start(): Promise<void> {
    process.on("SIGINT", () => void this.shutdown());
    process.on("SIGTERM", () => void this.shutdown());

    // Attach watchers before the initial build so changes made during the first
    // (potentially slow) build are not missed.
    this.setupWatchers();

    const status = await nativeStatus();
    info(`Native: ${nativeLabel(status)}`);

    await this.buildOnce();

    success(
      this.shouldSpawn
        ? "Watching for changes — press Ctrl+C to stop."
        : "Watching for changes (--no-spawn; no server process).",
    );
  }

  /**
   * Stop the current child and await its exit so the port is released before a
   * new server spawns (avoids the EADDRINUSE restart race). Falls back to
   * SIGKILL after 2s.
   */
  private async stopChild(): Promise<void> {
    const current = this.child;
    if (!current) return;

    // Already exited — nothing left to stop.
    if (current.exitCode !== null || current.signalCode !== null) {
      this.child = undefined;
      return;
    }

    this.stoppingChild = true;

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

    await exited.then(() => {
      this.stoppingChild = false;
      this.child = undefined;
    });
  }

  private startChild(entry: string): ChildProcess {
    step(`Starting ${relative(process.cwd(), entry)} with ${this.runtime}`);

    const spawned = spawnProcess(this.runtime, [entry], {
      stdio: "inherit",
      detached: process.platform !== "win32",
      env: {
        ...process.env,
        PORT: String(this.port),
        NODE_ENV: "development",
      },
    });

    this.child = spawned;

    // A server that survives past the healthy threshold resets the crash
    // counter so a sustained runtime fault doesn't accumulate across restarts.
    const healthTimer = setTimeout(() => {
      this.crashRestartAttempts = 0;
    }, HEALTHY_THRESHOLD_MS);
    healthTimer.unref?.();

    spawned.on("exit", (code, signal) => {
      clearTimeout(healthTimer);
      if (this.child === spawned) this.child = undefined;

      // Intentional stop or no server process — never auto-restart.
      if (this.stopping || this.stoppingChild || !this.shouldSpawn) return;
      // Clean exit (code 0) — nothing to do.
      if (code === 0) return;

      this.crashRestartAttempts += 1;

      if (this.crashRestartAttempts > MAX_CRASH_RESTARTS) {
        warn(
          `Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
            `Giving up after ${MAX_CRASH_RESTARTS} rapid restarts — it may be crashing on ` +
            `boot (e.g. the port is already in use). Waiting for a file change to retry.`,
        );
        return;
      }

      const delay = Math.min(CRASH_RESTART_BASE_MS * 2 ** (this.crashRestartAttempts - 1), 5_000);
      warn(
        `Server exited (code=${code ?? "null"}, signal=${signal ?? "null"}). ` +
          `Restarting in ${delay}ms (attempt ${this.crashRestartAttempts}/${MAX_CRASH_RESTARTS}).`,
      );

      this.crashRestartTimer = setTimeout(() => {
        if (this.stopping) return;
        this.child = this.startChild(entry);
      }, delay);
    });

    // A failed spawn (missing runtime binary, EACCES, missing entry) fires an
    // 'error' event on the ChildProcess, NOT 'exit'. Without a listener that
    // is an UNHANDLED event that crashes the dev process before the
    // crash-restart logic (keyed off 'exit') ever sees it. Route it through
    // the same backoff path. (For spawn failures Node does not also emit
    // 'exit', so the two handlers can't double-schedule.)
    spawned.on("error", (err) => {
      clearTimeout(healthTimer);
      if (this.child === spawned) this.child = undefined;
      if (this.stopping || this.stoppingChild || !this.shouldSpawn) return;

      this.crashRestartAttempts += 1;
      if (this.crashRestartAttempts > MAX_CRASH_RESTARTS) {
        warn(
          `Server failed to spawn (${err.message}). Giving up after ` +
            `${MAX_CRASH_RESTARTS} rapid attempts — it may be crashing on boot. ` +
            `Waiting for a file change to retry.`,
        );
        return;
      }

      const delay = Math.min(CRASH_RESTART_BASE_MS * 2 ** (this.crashRestartAttempts - 1), 5_000);
      warn(`Server failed to spawn (${err.message}). Restarting in ${delay}ms.`);

      this.crashRestartTimer = setTimeout(() => {
        if (this.stopping) return;
        this.child = this.startChild(entry);
      }, delay);
    });

    return spawned;
  }

  private async restart(entry: string): Promise<void> {
    await this.stopChild();
    this.child = this.startChild(entry);
  }

  private async buildOnce(): Promise<void> {
    if (this.building) {
      this.pending = true;
      return;
    }

    this.building = true;

    try {
      const { opts } = await buildProject(this.root, this.buildArgs);
      const entry = await findServerEntry(this.root, opts);

      if (!entry) {
        warn("Could not locate generated server entry. Set outDir/output or run with --no-spawn.");
      } else if (this.shouldSpawn) {
        await this.restart(entry);
      }

      this.lastBuildFailed = false;
      this.crashRestartAttempts = 0;
      success("Build ok — server is up to date");
    } catch (err) {
      this.lastBuildFailed = true;
      error(formatError(err));
      warn(
        "Build failed — the running server (if any) is still serving the previous build. " +
          "Fix the error and save a file to rebuild.",
      );
    } finally {
      this.building = false;

      if (this.pending) {
        this.pending = false;
        await this.buildOnce();
      }
    }
  }

  private scheduleRebuild(): void {
    if (this.timer) clearTimeout(this.timer);

    this.timer = setTimeout(() => {
      void this.buildOnce();
    }, REBUILD_DEBOUNCE_MS);
  }

  private async shutdown(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.timer) clearTimeout(this.timer);
    if (this.crashRestartTimer) clearTimeout(this.crashRestartTimer);
    for (const watcher of this.watchers) watcher.close();

    await this.stopChild();
    process.exit(this.lastBuildFailed ? 1 : 0);
  }

  /** Watch the project for changes; debounced rebuilds via {@link scheduleRebuild}. */
  private setupWatchers(): void {
    try {
      const watcher = watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        if (shouldIgnore(String(filename), this.outDir, this.root)) return;
        this.scheduleRebuild();
      });

      watcher.on("error", () => {
        // Ignore watch errors; rebuilds are debounced.
      });

      this.watchers.push(watcher);
    } catch {
      warn(
        "Recursive fs.watch unavailable. Watching src/, routes/, hooks/, and config files non-recursively.",
      );

      const routesDir = String(this.config.routesDir ?? "src/routes");
      const hooksDir = String(this.config.hooksDir ?? "src/hooks");

      const dirs = [routesDir, hooksDir, "src"].map((dir) => resolve(this.root, dir));

      for (const dir of dirs) {
        try {
          const watcher = watch(dir, (_event, filename) => {
            if (!filename) return;
            // Resolve against the watched dir so shouldIgnore sees absolute paths.
            if (shouldIgnore(resolve(dir, String(filename)), this.outDir, this.root)) return;
            this.scheduleRebuild();
          });

          watcher.on("error", () => {
            // noop
          });

          this.watchers.push(watcher);
        } catch {
          // Directory may not exist.
        }
      }

      // Single source of truth for config files (includes ignex.config.json).
      for (const file of CONFIG_FILES) {
        try {
          const watcher = watch(resolve(this.root, file), () => {
            this.scheduleRebuild();
          });

          watcher.on("error", () => {
            // noop
          });

          this.watchers.push(watcher);
        } catch {
          // File may not exist.
        }
      }

      try {
        const watcher = watch(resolve(this.root, "package.json"), () => {
          this.scheduleRebuild();
        });

        watcher.on("error", () => {
          // noop
        });

        this.watchers.push(watcher);
      } catch {
        // File may not exist.
      }
    }
  }
}

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

  // Pre-flight env validation (non-blocking warnings/errors).
  reportEnvCheck(await checkProjectEnv(root));

  const config = await loadConfig(root);
  const outDir = String(values.outDir ?? config.outDir ?? ".ignex");

  await new DevServer({
    root,
    runtime,
    port,
    shouldSpawn,
    outDir,
    config,
    buildArgs: values as BuildArgs,
  }).start();
}
