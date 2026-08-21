/**
 * @fileoverview `ignex migrate` — run the project's ninox schema migrations.
 *
 *   ignex migrate            → apply pending migrations (up)
 *   ignex migrate up         → apply pending migrations
 *   ignex migrate down       → roll back applied migrations (reverse order)
 *   ignex migrate down <n>   → roll back through migration <n>
 *   ignex migrate status     → list applied + pending migrations
 *   ignex migrate create <n> → scaffold a new `NNN_name.ts` migration file
 *
 * `up` / `down` / `status` delegate to the `migrations` runner exported by the
 * generated `src/db.ts` (`createMongoToolkit`), so they share the project's
 * configured collections, connection URL, and migration directory. `create` is
 * self-contained (a pure file write) so it works without a running database.
 */

import { mkdir, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCliArgs, resolveRoot } from "../utils/args.js";
import { exists, readTextFile, writeFileEnsuringDir } from "../utils/fs.js";
import { error, info, step, success } from "../utils/logger.js";

export const MIGRATION_ACTIONS = ["create", "up", "down", "status"] as const;
export type MigrationAction = (typeof MIGRATION_ACTIONS)[number];

/** Fallback migration dir when `src/db.ts` doesn't pin one (ninox parity). */
const DEFAULT_MIGRATION_DIR = "src/migrations";

/**
 * Resolve the migration directory the toolkit is configured with, by reading
 * the `migrationDir: "..."` option from `src/db.ts`. Falls back to the ninox
 * default so existing projects keep working.
 *
 * @param dbSource - Contents of the project's `src/db.ts`.
 * @returns Project-relative migration directory.
 */
export const resolveMigrationDir = (dbSource: string): string => {
  const match = /migrationDir:\s*"([^"]+)"/.exec(dbSource);
  return match?.[1] ?? DEFAULT_MIGRATION_DIR;
};

/** Migration file body (mirrors ninox's `migrations.create` template). */
export const migrationTemplate =
  (): string => `import type { MigrationContext } from "@ignex/ninox";

export const up = async (ctx: MigrationContext): Promise<void> => {
  // const db = ctx.service.db.primaryClient;
  // await db.createSchema("collectionName");
};

export const down = async (ctx: MigrationContext): Promise<void> => {
  // const db = ctx.service.db.primaryClient;
  // await db.client.dropCollection("collectionName");
};
`;

/** Sanitize a migration name to a safe filename fragment. */
const safeName = (name: string): string => name.replace(/[^A-Za-z0-9_-]+/g, "_");

/** Compute the next 3-padded migration number in a directory. */
export async function nextMigrationNumber(dir: string): Promise<number> {
  let max = 0;
  const entries = await readdir(dir).catch(() => [] as string[]);
  for (const file of entries) {
    const match = /^(\d{3})_/.exec(file);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

/**
 * Scaffold a new `NNN_name.ts` migration file — a pure file write, so it works
 * without a running database.
 *
 * @param root - Project root.
 * @param name - Migration name (e.g. `add-slug`).
 * @returns Absolute path of the created file.
 */
export async function createMigration(root: string, name: string): Promise<string> {
  const dbSource = await readTextFile(join(root, "src", "db.ts"));
  const dir = join(root, resolveMigrationDir(dbSource));
  await mkdir(dir, { recursive: true });
  const next = String(await nextMigrationNumber(dir)).padStart(3, "0");
  const fileName = `${next}_${safeName(name)}.ts`;
  const filePath = join(dir, fileName);
  await writeFileEnsuringDir(filePath, migrationTemplate());
  return filePath;
}

/** Minimal shape of the `migrations` runner exported by `src/db.ts`. */
interface MigrationsRunner {
  up(): Promise<void>;
  down(targetName?: string): Promise<void>;
  status(): Promise<{ applied: string[]; pending: string[] }>;
}

/** Load the project's configured runner from `src/db.ts`. */
async function loadRunner(dbPath: string): Promise<MigrationsRunner | undefined> {
  try {
    const mod = (await import(pathToFileURL(dbPath).href)) as { migrations?: MigrationsRunner };
    if (!mod.migrations) {
      error("src/db.ts does not export `migrations` — regenerate it with `ignex resource`.");
      process.exitCode = 1;
      return undefined;
    }
    return mod.migrations;
  } catch (err) {
    error(`Failed to load src/db.ts: ${err instanceof Error ? err.message : String(err)}`);
    error("Is MongoDB reachable? The db module connects at import time (MONGO_URL).");
    process.exitCode = 1;
    return undefined;
  }
}

/** Render `migrate status`. */
function renderStatus(status: { applied: string[]; pending: string[] }): void {
  console.log();
  if (status.applied.length > 0) {
    info("Applied:");
    for (const name of status.applied) console.log(`  ✔ ${name}`);
  } else {
    info("Applied: none");
  }
  console.log();
  if (status.pending.length > 0) {
    info("Pending:");
    for (const name of status.pending) console.log(`  → ${name}`);
  } else {
    info("Pending: none");
  }
  console.log();
}

/** Run `ignex migrate`. */
export async function runMigrate(args: string[]): Promise<void> {
  const { values, positionals } = parseCliArgs(args, {
    root: { type: "string" },
    action: { type: "string" },
    name: { type: "string" },
  });

  // The first positional is the action (+ optional name), never the root.
  const root = resolveRoot(values, positionals, { ignorePositionals: true });
  const action = ((values.action as string | undefined) ??
    positionals[0] ??
    "up") as MigrationAction;
  const name = (values.name as string | undefined) ?? positionals[1];

  if (!MIGRATION_ACTIONS.includes(action)) {
    error(`Unknown migrate action "${action}". Expected one of: ${MIGRATION_ACTIONS.join(", ")}.`);
    process.exitCode = 1;
    return;
  }

  const dbPath = join(root, "src", "db.ts");
  if (!(await exists(dbPath))) {
    error(
      "No src/db.ts found — scaffold a model first with `ignex resource <Name>` (or `ignex hotroute <Name>`).",
    );
    process.exitCode = 1;
    return;
  }

  // `create` is a pure file write — no DB connection needed.
  if (action === "create") {
    if (!name) {
      error("migrate create requires a name: `ignex migrate create <name>`");
      process.exitCode = 1;
      return;
    }
    const filePath = await createMigration(root, name);
    success(`Created ${relative(root, filePath)}`);
    info("Edit the file, then run `ignex migrate up`.");
    return;
  }

  const migrations = await loadRunner(dbPath);
  if (!migrations) return;

  switch (action) {
    case "up":
      step("Applying pending migrations");
      await migrations.up();
      success("Migrations up to date");
      break;
    case "down":
      if (name) info(`Rolling back through ${name}`);
      await migrations.down(name);
      success("Rolled back");
      break;
    case "status":
      renderStatus(await migrations.status());
      break;
    default:
      break;
  }
}
