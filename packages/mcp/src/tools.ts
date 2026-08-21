/**
 * Ignex MCP tools — the agent-facing operations.
 *
 * Each tool returns a plain string (or JSON string) rendered as a text block,
 * and degrades gracefully: build/route/openapi never throw into the protocol
 * when a project is missing — they return an actionable message instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseRouteInput, routeFileTemplate } from "@ignex/cli/route";
import { buildAsync } from "@ignex/compiler";
import { isNativeAvailable } from "@ignex/native";

const cwd = (root?: string): string => resolve(root ?? process.cwd());

const safeJson = (value: unknown): string => JSON.stringify(value, null, 2);

const bunGlobal = (): { version?: string } | undefined =>
  (globalThis as { Bun?: { version?: string } }).Bun;

/** Runtime detection that works both under Bun and in node-ish environments. */
const isBunRuntime = (): boolean =>
  typeof bunGlobal() !== "undefined" ||
  (typeof process !== "undefined" && "bun" in (process.versions ?? {}));

const bunVersion = (): string | undefined => bunGlobal()?.version;

export interface BuildToolArgs {
  root: string | undefined;
  outDir: string | undefined;
  routesDir: string | undefined;
  minify: boolean | undefined;
}

/** Compile a project and summarize the result (cached, artifacts, errors). */
export const runBuildTool = async (args: BuildToolArgs): Promise<string> => {
  const root = cwd(args.root);
  try {
    const result = await buildAsync({
      routesDir: args.routesDir ? resolve(root, args.routesDir) : join(root, "src/routes"),
      outDir: args.outDir ? resolve(root, args.outDir) : join(root, ".ignex"),
      outFile: "server.js",
      minify: args.minify ?? false,
      generateTypes: true,
      generateOpenAPI: true,
      generateClient: true,
      precompileValidators: true,
      precompileSerializers: true,
    });

    const summary = {
      ok: result.errors.length === 0,
      outFile: relative(process.cwd(), result.outFile),
      cached: result.cached ?? false,
      warnings: result.warnings.map((w) => `${w.code}: ${w.message}`),
      errors: result.errors.map((e) => `${e.code}: ${e.message}`),
      metadata: result.metadata,
    };

    return safeJson(summary);
  } catch (error) {
    return safeJson({ ok: false, error: String(error) });
  }
};

export interface RouteToolArgs {
  root: string | undefined;
  input: string;
  method: string | undefined;
  schema: boolean | undefined;
  named: boolean | undefined;
  force: boolean | undefined;
}

/** Scaffold a route file, reusing the CLI's template + filename parsing. */
export const runRouteTool = async (args: RouteToolArgs): Promise<string> => {
  const root = cwd(args.root);

  // `parseRouteInput` throws on empty/invalid input, traversal, or a bad
  // method — NEVER let that become an exception in the MCP protocol. Return a
  // structured error so the agent gets an actionable message instead.
  let parsed: ReturnType<typeof parseRouteInput>;
  try {
    parsed = parseRouteInput(args.input, args.method);
  } catch (error) {
    return safeJson({
      ok: false,
      error: `Invalid route input: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  const routesDir = join(root, "src/routes");
  const filePath = join(routesDir, parsed.file);

  if (existsSync(filePath) && !args.force) {
    return safeJson({
      ok: false,
      error: `${relative(process.cwd(), filePath)} already exists (pass force: true to overwrite).`,
    });
  }

  // Never throw into the MCP protocol on disk/permission failures — return a
  // structured error so the agent gets an actionable message instead of a
  // broken tool call.
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      routeFileTemplate(parsed, {
        schema: Boolean(args.schema),
        named: Boolean(args.named),
      }),
    );
  } catch (error) {
    return safeJson({
      ok: false,
      error: `Failed to write route: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return safeJson({
    ok: true,
    method: parsed.method,
    path: parsed.routePath,
    file: relative(process.cwd(), filePath),
  });
};

export interface InfoToolArgs {
  root: string | undefined;
}

/** Environment + config snapshot for the project root. */
export const runInfoTool = async (args: InfoToolArgs): Promise<string> => {
  const root = cwd(args.root);
  const configPath = join(root, "ignex.config.mjs");
  const appConfigPath = join(root, "src/app.config.ts");

  return safeJson({
    cwd: root,
    runtime: isBunRuntime() ? "bun" : "node",
    versions: {
      bun: bunVersion(),
      node: typeof process !== "undefined" ? process.version : undefined,
    },
    native: isNativeAvailable(),
    config: existsSync(configPath) ? configPath : null,
    appConfig: existsSync(appConfigPath) ? appConfigPath : null,
    routesDir: join(root, "src/routes"),
  });
};

/** Health-check the environment (doctor): runtime, native, project config. */
export const runDoctorTool = async (): Promise<string> => {
  const checks = [
    {
      name: "runtime",
      ok: isBunRuntime(),
      detail: isBunRuntime()
        ? bunVersion()
          ? `Bun ${bunVersion()}`
          : "Bun-compatible runtime"
        : `Node ${process.version}`,
    },
    {
      name: "native-acceleration",
      ok: isNativeAvailable(),
      detail: isNativeAvailable()
        ? "native addon (castrum) active"
        : "native addon missing — pure-TS fallbacks active (set IGNEX_NATIVE_PATH to override)",
    },
    {
      name: "compiler",
      // Real probe (was a hardcoded `ok: true` stub): the compiler API must
      // actually be importable + callable from this process.
      ok: typeof buildAsync === "function",
      detail: "@ignex/compiler importable",
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  return safeJson({ ok: failed.length === 0, checks });
};

export interface ListRoutesToolArgs {
  root: string | undefined;
}

/** Enumerate the project's route files (no build required). */
export const runListRoutesTool = async (args: ListRoutesToolArgs): Promise<string> => {
  const root = cwd(args.root);
  const routesDir = join(root, "src/routes");
  if (!existsSync(routesDir)) {
    return safeJson({
      ok: false,
      error: `No routes directory at ${relative(process.cwd(), routesDir)}`,
    });
  }

  const files: string[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const abs = join(dir, entry);
      const stat = statSync(abs);
      if (stat.isDirectory()) {
        walkDir(abs);
      } else if (/^[^.].*\.(ts|js|mjs|tsx|jsx)$/.test(entry)) {
        files.push(relative(routesDir, abs).replace(/\\/g, "/"));
      }
    }
  };
  walkDir(routesDir);
  files.sort();

  return safeJson({
    ok: true,
    routesDir: relative(process.cwd(), routesDir),
    count: files.length,
    files,
  });
};

export interface OpenApiToolArgs {
  root: string | undefined;
}

/** Build (if needed) and return the generated openapi.json. */
export const runOpenApiTool = async (args: OpenApiToolArgs): Promise<string> => {
  const root = cwd(args.root);

  // Respect the project's ignex.config (read as TEXT — never execute it):
  // honor outDir/routesDir and skip a rebuild when openapi.json already
  // exists. Previously this unconditionally rebuilt and used a hardcoded
  // `.ignex/openapi.json`, ignoring any custom outDir.
  const configPath = join(root, "ignex.config.mjs");
  const configText = existsSync(configPath) ? readFileSync(configPath, "utf8") : "";
  const outDirMatch = /outDir\s*:\s*["']([^"']+)["']/.exec(configText);
  const routesDirMatch = /routesDir\s*:\s*["']([^"']+)["']/.exec(configText);
  const generateOpenApi = !/generateOpenAPI\s*:\s*false/.test(configText);
  const outDir = outDirMatch?.[1] ? resolve(root, outDirMatch[1]) : join(root, ".ignex");
  const routesDir = routesDirMatch?.[1]
    ? resolve(root, routesDirMatch[1])
    : join(root, "src/routes");
  const openapiPath = join(outDir, "openapi.json");

  if (!existsSync(openapiPath)) {
    if (!generateOpenApi) {
      return safeJson({ ok: false, error: "generateOpenAPI is disabled for this project" });
    }
    const build = await runBuildTool({ root: args.root, outDir, routesDir, minify: undefined });
    const summary = JSON.parse(build) as { ok?: boolean; error?: string };
    if (!summary.ok) {
      return safeJson({ ok: false, error: `Build failed: ${summary.error ?? "unknown error"}` });
    }
  }

  try {
    const doc = JSON.parse(readFileSync(openapiPath, "utf-8"));
    return safeJson({ ok: true, path: relative(process.cwd(), openapiPath), openapi: doc });
  } catch (error) {
    return safeJson({ ok: false, error: String(error) });
  }
};

export interface DevToolArgs {
  root: string | undefined;
  port: number | undefined;
}

/** Tracked live dev servers, keyed by pid, so `devStop` can stop them. */
const devServers = new Map<number, unknown>();

/**
 * Spawn `ignex dev` in the project and report the outcome. Waits for the
 * spawn `error`/`spawn` events so a failed spawn (bunx missing) is reported
 * as `{ ok: false }` instead of a false `{ ok: true, pid }`.
 */
export const runDevTool = async (args: DevToolArgs): Promise<string> => {
  const root = cwd(args.root);
  const argsList = ["ignex", "dev", root];
  if (args.port) argsList.push("--port", String(args.port));

  return new Promise<string>((resolveResult) => {
    let settled = false;
    const child = spawn("bunx", argsList, {
      cwd: root,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const events = child as unknown as {
      on(event: string, listener: (...a: unknown[]) => void): void;
    };

    const finish = (payload: Record<string, unknown>): void => {
      if (settled) return;
      settled = true;
      resolveResult(safeJson(payload));
    };

    events.on("error", (err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[ignex-mcp] failed to spawn dev server (bunx unavailable?): ${message}`);
      finish({ ok: false, error: `Failed to spawn bunx: ${message}` });
    });

    events.on("spawn", () => {
      if (child.pid != null) devServers.set(child.pid, child);
      finish({
        ok: true,
        pid: child.pid,
        command: `bunx ${argsList.join(" ")}`,
        note: "dev server launched in the background; logs are not streamed. Stop it with the `devStop` tool (or kill the pid).",
      });
    });

    // Safety net: if neither event fires (unlikely), don't hang the tool.
    const t = setTimeout(
      () => finish({ ok: false, error: "Timed out waiting for the dev server to spawn." }),
      5000,
    );
    t.unref?.();
  });
};

/** Stop a previously-spawned dev server by pid. */
export const runDevStopTool = (args: { pid: number }): string => {
  if (!devServers.has(args.pid)) {
    return safeJson({ ok: false, error: `No tracked dev server with pid ${args.pid}.` });
  }
  try {
    process.kill(args.pid, "SIGTERM");
    devServers.delete(args.pid);
    return safeJson({ ok: true, stopped: args.pid });
  } catch (error) {
    return safeJson({ ok: false, error: `Failed to stop ${args.pid}: ${String(error)}` });
  }
};
