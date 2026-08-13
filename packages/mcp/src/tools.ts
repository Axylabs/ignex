/**
 * Ignex MCP tools — the agent-facing operations.
 *
 * Each tool returns a plain string (or JSON string) rendered as a text block,
 * and degrades gracefully: build/route/openapi never throw into the protocol
 * when a project is missing — they return an actionable message instead.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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
  const parsed = parseRouteInput(args.input, args.method);

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
      ok: true,
      detail: "@ignex/compiler importable",
    },
  ];

  const failed = checks.filter((c) => !c.ok);
  return safeJson({ ok: failed.length === 0, checks });
};

export interface OpenApiToolArgs {
  root: string | undefined;
}

/** Build (if needed) and return the generated openapi.json. */
export const runOpenApiTool = async (args: OpenApiToolArgs): Promise<string> => {
  const root = cwd(args.root);
  const outDir = join(root, ".ignex");
  const openapiPath = join(outDir, "openapi.json");

  await runBuildTool({ root: args.root, outDir, routesDir: undefined, minify: undefined });

  if (!existsSync(openapiPath)) {
    return safeJson({ ok: false, error: "openapi.json was not generated (check generateOpenAPI)" });
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

/** Spawn `ignex dev` in the project and report the process. */
export const runDevTool = (args: DevToolArgs): string => {
  const root = cwd(args.root);
  const argsList = ["ignex", "dev", root];
  if (args.port) argsList.push("--port", String(args.port));

  const child = spawn("bunx", argsList, {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return safeJson({
    ok: true,
    pid: child.pid,
    command: `bunx ${argsList.join(" ")}`,
    note: "dev server launched in the background; logs are not streamed to the agent.",
  });
};
