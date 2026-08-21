/**
 * `ignex tinker` — an interactive REPL booted inside your app's context.
 *
 * Laravel's `php artisan tinker` equivalent: load the project's generated
 * `src/db.ts` (the ninox toolkit: `db`, `service`, `migrations`), the typed
 * env config, and the nova events facade, then drop into a REPL where you can
 * run real queries, emit events, and exercise app code against a LIVE
 * database — without starting the HTTP server.
 *
 *   ignex tinker                → REPL with db / env / service / events
 *   ignex tinker --no-db        → skip the (possibly slow) Mongo connect
 *
 * The REPL is `node:repl` running under Bun, so `await` works at top level
 * (replServer evaluates with `await` enabled). Variables exposed:
 *   db       the typed CRUD manager (proxy) from src/db.ts
 *   service  the ninox toolkit service (makeConnections/closeConnections)
 *   env      the typed environment config
 *   events   the @ignex/nova events facade (emit/emitToUser/on) when available
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import * as repl from "node:repl";
import { pathToFileURL } from "node:url";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { loadConfig } from "../utils/config.js";
import { error, info, success } from "../utils/logger.js";

/** What `ignex tinker` exposes in the REPL context. */
interface TinkerContext {
  db?: unknown;
  service?: unknown;
  env?: Record<string, unknown>;
  events?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Best-effort import of a project module; returns `undefined` on failure. */
async function tryImport(url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const mod = (await import(url)) as Record<string, unknown>;
    return mod;
  } catch {
    return undefined;
  }
}

/** Resolve the project's `src/db.ts` (ninox toolkit) or null when absent. */
async function loadDbContext(root: string): Promise<Record<string, unknown> | null> {
  for (const candidate of ["src/db.ts", "src/db.tsx", "db.ts"]) {
    const abs = join(root, candidate);
    if (!existsSync(abs)) continue;
    const mod = await tryImport(`${pathToFileURL(abs).href}?t=${Date.now()}`);
    if (!mod) continue;
    return {
      db: mod.db,
      service: mod.service,
      migrations: mod.migrations,
      initDb: mod.initDb,
      dbPlugin: mod.dbPlugin,
    };
  }
  return null;
}

/** Resolve the typed env config (`src/config/env.ts`) or null when absent. */
async function loadEnvContext(root: string): Promise<Record<string, unknown> | null> {
  for (const candidate of ["src/config/env.ts", "src/config/env.tsx"]) {
    const abs = join(root, candidate);
    if (!existsSync(abs)) continue;
    const mod = await tryImport(`${pathToFileURL(abs).href}?t=${Date.now()}`);
    if (!mod) return null;
    // defineEnv returns { env } — expose whatever named bindings exist.
    return mod;
  }
  return null;
}

/** Resolve the @ignex/nova events facade when the project has it installed. */
async function loadEventsContext(): Promise<Record<string, unknown> | undefined> {
  try {
    // Variable specifier: defeats static resolution (vitest/vite would try to
    // resolve the literal and fail when the installed nova version doesn't
    // export ./events yet); the package is an optional dependency.
    const spec = "@ignex/nova/events";
    const mod = (await import(spec)) as Record<string, unknown>;
    return {
      emit: mod.emit,
      emitToUser: mod.emitToUser,
      emitToGroup: mod.emitToGroup,
      emitToTopic: mod.emitToTopic,
      emitToClient: mod.emitToClient,
      on: mod.on,
      off: mod.off,
    };
  } catch {
    return undefined;
  }
}

/** Boot the project's db connections (idempotent). */
async function connectDb(
  service: { makeConnections?: () => Promise<void> } | undefined,
): Promise<void> {
  if (!service?.makeConnections) return;
  try {
    await service.makeConnections();
  } catch (err) {
    error(`Mongo connect failed: ${err instanceof Error ? err.message : String(err)}`);
    info("The REPL still works without a DB; `db` calls will throw until connected.");
  }
}

export async function runTinker(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    "no-db": { type: "boolean" },
  });
  const root = resolveRoot(values, positionals);
  const config = await loadConfig(root);
  const dbFlag = values["no-db"] !== true;

  const ctx: TinkerContext = {};

  // Typed env config (e.g. { env, defineEnv } from src/config/env.ts).
  const envMod = await loadEnvContext(root);
  if (envMod) {
    if ("env" in envMod) ctx.env = envMod.env as Record<string, unknown>;
    else ctx.env = envMod;
  }

  // Ninox toolkit (db / service / migrations) when the project has a db.ts.
  const dbCtx = await loadDbContext(root);
  if (dbCtx) {
    ctx.db = dbCtx.db;
    ctx.service = dbCtx.service;
    ctx.migrations = dbCtx.migrations;
    if (dbFlag) {
      await connectDb(dbCtx.service as { makeConnections?: () => Promise<void> });
      success("Mongo connected — `db` is live (try: await db.getOne('gigs', {}))");
    } else {
      info("--no-db: skipping Mongo connect; call `service.makeConnections()` to connect.");
    }
  } else {
    info("No src/db.ts found — expose `db` by scaffolding a model (`ignex model <Name>`).");
  }

  // Nova events facade (emitToUser / on / …) when @ignex/nova is installed.
  const events = await loadEventsContext();
  if (events) ctx.events = events;

  info(`Tinker — ${relative(process.cwd(), root) || "."} context. Try: db, env, service, events.`);
  info("Type .exit or Ctrl-D twice to leave. Top-level `await` works.");

  // `await: true` is what enables top-level await in the REPL; it's typed as
  // part of the runtime options but not in the pinned node types, so start
  // with the typed surface and apply it via a cast.
  const r = repl.start({
    prompt: "ignex> ",
    useGlobal: false,
    ignoreUndefined: true,
  } as repl.ReplOptions & { await?: boolean });
  (r as unknown as { await?: boolean }).await = true;
  r.context.db = ctx.db;
  r.context.service = ctx.service;
  r.context.env = ctx.env;
  r.context.events = ctx.events;
  r.context.config = config;

  // Close the db pool when the REPL exits (Ctrl-D / .exit).
  r.on("exit", () => {
    const service = ctx.service as { closeConnections?: () => Promise<void> } | undefined;
    if (service?.closeConnections) {
      void service.closeConnections().catch(() => {});
    }
  });
}
