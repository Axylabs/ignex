/**
 * Migration file discovery + loading + scaffolding (pure filesystem helpers).
 * `listMigrationFiles` orders by the numeric prefix; `loadMigration` imports a
 * file as a module; `nextMigrationNumber`/`ensureDir` support `create`.
 */
import { mkdir, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { MIGRATION_FILE, type MigrationModule } from "./types.ts";

/** Strip the `NNN_` prefix and extension → the migration's logical name. */
export const migrationNameOf = (file: string): string =>
  basename(file).replace(/\.(ts|js|mjs)$/, "");

/** List migration files in a directory, ordered by numeric prefix. */
export const listMigrationFiles = async (dir: string): Promise<string[]> => {
  const files = await readdir(dir);
  return files.filter((file) => MIGRATION_FILE.test(file)).sort();
};

/** Import a migration file as `{ up, down }` + its logical name. */
export const loadMigration = async (
  dir: string,
  file: string,
): Promise<MigrationModule & { name: string }> => {
  const mod = (await import(pathToFileURL(join(dir, file)).href)) as MigrationModule;
  return { name: migrationNameOf(file), ...mod };
};

/** Ensure the migration directory exists. */
export const ensureMigrationDir = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true });
};

/** The next free numeric prefix (max existing + 1). */
export const nextMigrationNumber = async (dir: string): Promise<number> => {
  const files = await readdir(dir);
  return (
    files.reduce((max, file) => {
      const match = MIGRATION_FILE.exec(file);
      return match ? Math.max(max, Number(match[1])) : max;
    }, 0) + 1
  );
};
