import { type ChildProcess, spawn as spawnProcess, spawnSync } from "node:child_process";
import { type FSWatcher, watch } from "node:fs";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildProject, findServerEntry } from "../utils/compiler.js";
import { loadConfig } from "../utils/config.js";
import { error, step, success, warn } from "../utils/logger.js";

export async function runDev(args: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    options: {
      root: { type: "string" },
      port: { type: "string" },
      runtime: { type: "string" },
      spawn: { type: "boolean" },
      outDir: { type: "string" },
      routesDir: { type: "string" },
      verbose: { type: "boolean" },
    },
    allowPositionals: true,
    strict: false,
  });

  const root = resolve((values.root as string | undefined) ?? positionals[0] ?? ".");
  const runtime = detectRuntime(values.runtime as string | undefined);
  const port = (values.port as string | undefined) ?? process.env.PORT ?? "3000";
  // `--no-spawn` is parsed by node:util/parseArgs as the "no-spawn" key, so
  // support the negation explicitly.
  const noSpawn = (values as Record<string, unknown>)["no-spawn"] === true;
  const shouldSpawn = values.spawn !== false && !noSpawn;

  let child: ChildProcess | undefined;
  let timer: NodeJS.Timeout | undefined;
  let building = false;
  let pending = false;

  const watchers: FSWatcher[] = [];

  function stopChild(): void {
    if (!child) return;

    const pid = child.pid;

    if (process.platform === "win32" && pid) {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
      });
    } else if (process.platform !== "win32" && pid) {
      try {
        process.kill(-pid, "SIGTERM");
      } catch {
        try {
          child.kill("SIGTERM");
        } catch {
          // noop
        }
      }
    } else {
      try {
        child.kill("SIGTERM");
      } catch {
        // noop
      }
    }

    child = undefined;
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

    spawned.on("exit", (code, signal) => {
      if (code !== null && code !== 0) {
        warn(`Server exited code=${code} signal=${signal ?? "null"}`);
      }
    });

    return spawned;
  }

  function restart(entry: string): void {
    stopChild();
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
      }

      if (shouldSpawn && entry) {
        restart(entry);
      }

      success("Dev build ready");
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
      buildOnce().catch((err) => {
        error(err instanceof Error ? err.message : String(err));
      });
    }, 120);
  }

  await buildOnce().catch((err) => {
    error(err instanceof Error ? err.message : String(err));
  });

  const config = await loadConfig(root);
  const outDir = String(values.outDir ?? config.outDir ?? ".flux");

  function shouldIgnore(filename: string): boolean {
    const normalized = filename.replaceAll("\\", "/");
    const normalizedOut = outDir.replaceAll("\\", "/").replace(/^\.\//, "");

    const lockfiles = new Set(["bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

    const basename = normalized.split("/").pop() ?? "";

    return (
      normalized.includes("node_modules/") ||
      normalized.startsWith(".git/") ||
      normalized.startsWith(`${normalizedOut}/`) ||
      normalized.includes("/dist/") ||
      normalized.endsWith(".log") ||
      lockfiles.has(basename)
    );
  }

  function onClose(): void {
    stopChild();

    for (const watcher of watchers) {
      watcher.close();
    }

    process.exit(0);
  }

  process.on("SIGINT", onClose);
  process.on("SIGTERM", onClose);

  try {
    const watcher = watch(root, { recursive: true }, (_event, filename) => {
      if (!filename) return;

      const file = String(filename);
      if (shouldIgnore(file)) return;

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
          if (shouldIgnore(String(filename))) return;
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

    const files = [
      "flux.config.ts",
      "flux.config.mts",
      "flux.config.mjs",
      "flux.config.js",
      "package.json",
    ];

    for (const file of files) {
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
  }
}

function commandExists(command: string): boolean {
  try {
    const result = spawnSync(command, ["--version"], {
      stdio: "ignore",
    });

    return result.status === 0;
  } catch {
    return false;
  }
}

function detectRuntime(preferred?: string): string {
  if (preferred === "node") {
    return process.execPath;
  }

  if (preferred === "bun") {
    if (process.versions.bun || commandExists("bun")) {
      return "bun";
    }

    warn("bun not found, falling back to node");
    return process.execPath;
  }

  if (process.versions.bun) {
    return "bun";
  }

  if (commandExists("bun")) {
    return "bun";
  }

  return process.execPath;
}
